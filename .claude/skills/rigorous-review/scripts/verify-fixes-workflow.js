export const meta = {
  name: 'rigorous-review-verify-fixes',
  description:
    '自動適用した修正を独立エージェントで敵対的に再検証する。指摘を解消できているか・新たな回帰（呼び出し元の破壊や別の仕様違反）を生んでいないかを点検し、維持/巻き戻し/手動見直しの判定を返す',
  phases: [{ title: 'VerifyFix', detail: '適用済みの各修正を敵対的に再検証' }],
}

// ---- 入力 (args) ----
// {
//   scopeLabel: 人間向けの対象説明
//   diffCmd:    修正適用後の差分を表示するコマンド（例: "git -C <dir> diff HEAD"）
//   fixes: [    自動適用した修正の配列
//     { title, file, line, severity, category, findingDescription, suggestedFix, appliedChange }
//   ]
// }
let A = args || {}
if (typeof A === 'string') {
  try {
    A = JSON.parse(A)
  } catch (e) {
    A = {}
  }
}
const scopeLabel = A.scopeLabel || '(対象不明)'
const diffCmd = A.diffCmd || 'git diff HEAD'
const fixes = Array.isArray(A.fixes) ? A.fixes : []

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const sevRank = (s) => (s in SEV_RANK ? SEV_RANK[s] : 2)

const FIX_VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    resolved: { type: 'boolean', description: '元の指摘を実際に解消できているか' },
    regression: {
      type: 'boolean',
      description: 'この修正が新たな不具合・呼び出し元の破壊・別の仕様違反を生んでいる疑いがあるか',
    },
    reason: { type: 'string', description: 'コードを読んだうえでの根拠' },
    recommendation: {
      type: 'string',
      enum: ['keep', 'revert', 'manual'],
      description: 'keep=維持してよい / revert=巻き戻し推奨 / manual=解消不十分・判断困難で手動見直し',
    },
  },
  required: ['resolved', 'regression', 'reason', 'recommendation'],
}

// 検証レンズ（修正に対する別々の懐疑角度）
const FIX_LENSES = [
  '解消性: 元の指摘の根本原因がこの変更で本当に消えたか。表面的・部分的な手当てで取り残しが無いか',
  '回帰: この変更が呼び出し元・戻り値・型・例外・副作用を通じて新たな破壊や別の仕様違反を生んでいないか',
]

function verifyFixPrompt(fix, lens) {
  return [
    `自動適用された修正が妥当かを敵対的に検証する。デフォルトの立場は「解消は不十分 (resolved=false)」「回帰を積極的に疑う」。コードを読んで本当に問題ないと確証できたときだけ keep にする。`,
    ``,
    `## 元の指摘`,
    `- 種別: ${fix.category} / 重要度: ${fix.severity}`,
    `- 箇所: ${fix.file}:${fix.line}`,
    `- 内容: ${fix.findingDescription}`,
    `- 想定していた修正方針: ${fix.suggestedFix}`,
    fix.appliedChange ? `- 実際に適用した変更:\n${fix.appliedChange}` : ``,
    ``,
    `## 対象`,
    `${scopeLabel} / 修正適用後の差分は \`${diffCmd}\` で見える`,
    ``,
    `## あなたの検証レンズ`,
    lens,
    ``,
    `## 手順`,
    `1. ${fix.file} を Read し、修正後の実装と周辺（呼び出し元・型・例外パス）を実際に確認する`,
    `2. レンズの観点で問題を能動的に探す:`,
    `   - 解消性: 指摘の根本原因が残っていないか。条件分岐や別経路で同じバグが再発しないか`,
    `   - 回帰: 戻り値の形・型・例外・副作用の変化が呼び出し元を壊さないか。別の仕様に反していないか`,
    `3. 判定:`,
    `   - 解消済み かつ 回帰の疑いなし → recommendation=keep, resolved=true, regression=false`,
    `   - 回帰の疑いあり → recommendation=revert, regression=true（解消できていても回帰があれば revert）`,
    `   - 解消が不完全 / 判断困難 → recommendation=manual`,
  ]
    .filter((s) => s !== '')
    .join('\n')
}

if (fixes.length === 0) {
  return { scopeLabel, verdicts: [] }
}

// 各修正を 2 レンズで並列検証。回帰には厳しく倒す（1 票でも回帰疑いなら revert 寄り）
const verdicts = await parallel(
  fixes.map((fix) => () =>
    parallel(
      FIX_LENSES.map((lens) => () =>
        agent(verifyFixPrompt(fix, lens), {
          label: `verify-fix:${fix.category}:${(fix.file || '').split('/').pop()}`,
          phase: 'VerifyFix',
          schema: FIX_VERDICT_SCHEMA,
        }),
      ),
    ).then((votes) => {
      const v = votes.filter(Boolean)
      if (v.length === 0) {
        // 検証不能（レート制限等）は安全側で手動見直しに回す（黙って keep しない）
        return { ...fix, verdict: { decision: 'manual', resolved: false, regression: false, reasons: ['検証エージェントが結果を返せず検証不能。手動確認を推奨'] } }
      }
      const regression = v.some((x) => x.regression || x.recommendation === 'revert')
      const resolvedCount = v.filter((x) => x.resolved).length
      let decision
      if (regression) {
        decision = 'revert' // 回帰の疑いがあれば 1 票でも巻き戻し（安全最優先）
      } else if (resolvedCount >= Math.ceil(v.length / 2)) {
        decision = 'keep'
      } else {
        decision = 'manual'
      }
      return {
        ...fix,
        verdict: { decision, resolved: resolvedCount, votes: v.length, reasons: v.map((x) => x.reason) },
      }
    }),
  ),
)

verdicts.sort((a, b) => sevRank(a.severity) - sevRank(b.severity))

const keep = verdicts.filter((x) => x.verdict.decision === 'keep').length
const revert = verdicts.filter((x) => x.verdict.decision === 'revert').length
const manual = verdicts.filter((x) => x.verdict.decision === 'manual').length

return { scopeLabel, summary: { total: verdicts.length, keep, revert, manual }, verdicts }
