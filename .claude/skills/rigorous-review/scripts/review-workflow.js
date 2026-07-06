export const meta = {
  name: 'rigorous-implementation-review',
  description:
    '変更差分を複数レンズで広く検出し、各指摘を独立した懐疑エージェントで敵対的に多数決検証して、確定指摘リストだけを返す',
  phases: [
    { title: 'Detect', detail: 'レンズ別に不具合・仕様漏れを広く洗い出す' },
    { title: 'Verify', detail: '各指摘を独立した懐疑エージェントで反証検証し誤検知を削る' },
  ],
}

// ---- 入力 (args) ----
// {
//   scopeLabel:   人間向けの対象説明（例: "PR #123 (game8inc/meltan)"）
//   diffCmd:      差分を表示するシェルコマンド（例: "gh pr diff 123" / "git diff HEAD" / "git diff main...HEAD"）
//   changedFiles: 変更ファイルパスの配列
//   specContext:  要件・仕様の要約（PR本文/Issue/コミット由来）。無ければ「仕様情報なし」を明示した文字列
//   checkResults: typecheck/lint/test/build の実行結果サマリ（失敗は一次証拠）。未実行なら「（チェック未実行）」
//   thoroughness: "thorough" | "standard"
// }
// args はハーネスによっては JSON 文字列で届くため、文字列なら parse する（defense-in-depth）
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
const changedFiles = Array.isArray(A.changedFiles) ? A.changedFiles : []
const specContext = A.specContext || '（仕様情報なし。意図はコードとコミットから推測する）'
const checkResults = A.checkResults || '（チェック未実行）'
const thorough = A.thoroughness !== 'standard'

// 検出レンズ。spec-completeness が「漏れ」、それ以外が「不備」の主担当
const ALL_LENSES = [
  {
    key: 'correctness',
    focus:
      'ロジック誤り・境界条件（off-by-one / 空配列 / 0 / 最大値）・null/undefined 参照・型の取り違え・条件分岐の抜け・戻り値や符号の取り違え・状態遷移の矛盾',
  },
  {
    key: 'error-handling',
    focus:
      '異常系・例外・失敗パスの未処理・エラーの握り潰し（silent failure）・不適切なフォールバック・リトライ/タイムアウト欠如・リソースリーク・部分的失敗時の不整合',
  },
  {
    key: 'concurrency-data',
    focus:
      '競合・レース条件・トランザクション境界・ロック漏れ・N+1・データ整合性・冪等性欠如・マイグレーションとスキーマ/コードの齟齬・キャッシュ無効化漏れ',
  },
  {
    key: 'security',
    focus:
      '認可/認証の抜け・入力検証不足・各種インジェクション・機密情報の露出やログ出力・SSRF/パストラバーサル・安全でないデフォルト・権限昇格',
  },
  {
    key: 'spec-completeness',
    focus:
      '仕様・要件に対する実装漏れ・考慮漏れ・未対応エッジケース・後方互換性の破壊・UI/API/DB の不整合・要件にあるが実装されていない分岐。specContext と一行ずつ突き合わせる',
  },
  {
    key: 'tests',
    focus:
      'テスト網羅性の穴・新規/変更コードに対するテスト欠如・回帰の見落とし・常に通る/常に落ちる無意味なテスト・モックで本質を隠したテスト',
  },
]

// standard は不備・漏れの主観点に絞る。thorough は全レンズ
const LENSES = thorough
  ? ALL_LENSES
  : ALL_LENSES.filter((l) => ['correctness', 'error-handling', 'spec-completeness'].includes(l.key))

// 各巡は「全レンズ検出 → 意味的 dedup → 敵対的検証」。dedup が効くので thorough でも 2 巡で十分
// （2 巡目は 1 巡目で出た指摘を seen として渡し、深い/間接的な不備の拾い直しだけを狙う）
const ROUNDS = thorough ? 2 : 1
const MAX_VERIFY_PER_ROUND = 20 // 検証コストの暴走防止。超過分は重要度順に絞り log で明示

const SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 }
const sevRank = (s) => (s in SEV_RANK ? SEV_RANK[s] : 2)

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string', description: '一行要約' },
          file: { type: 'string', description: '対象ファイルパス' },
          line: { type: 'number', description: '対象行（差分の RIGHT 側絶対行番号。不明なら 0）' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          category: {
            type: 'string',
            enum: ['correctness', 'error-handling', 'concurrency', 'data', 'security', 'spec-gap', 'test-gap'],
          },
          description: { type: 'string', description: '何がどう問題か。再現条件・影響を含める' },
          evidence: {
            type: 'string',
            description: 'コード/コミット/チェック出力に基づく根拠。実証が弱ければ推測である旨を明記',
          },
          fixConfidence: {
            type: 'string',
            enum: ['high', 'medium', 'low'],
            description:
              'high=機械的に確実に直せる（型エラー・ガード漏れ・明白なロジック誤り）。medium/low=設計判断・仕様解釈・大きめの変更を要する',
          },
          suggestedFix: { type: 'string', description: '具体的な修正方針' },
        },
        required: [
          'title',
          'file',
          'line',
          'severity',
          'category',
          'description',
          'evidence',
          'fixConfidence',
          'suggestedFix',
        ],
      },
    },
  },
  required: ['findings'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    refuted: { type: 'boolean', description: 'この指摘は誤り/無効/差分起因でないと判断したら true' },
    reason: { type: 'string', description: '反証または追認の根拠（読んだコード・git log・チェック出力に基づく）' },
    severityAdjusted: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
    fixConfidenceAdjusted: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['refuted', 'reason', 'severityAdjusted', 'fixConfidenceAdjusted'],
}

function detectPrompt(lens, seenList, round) {
  return [
    `あなたは実装レビューの専門家。観点「${lens.key}」だけに集中して、変更差分に潜む不備・漏れを洗い出す。`,
    `フォーカス: ${lens.focus}`,
    ``,
    `## 対象`,
    `${scopeLabel}`,
    `差分の見方: シェルで \`${diffCmd}\` を実行すると差分が見える。必要なら Read で周辺コード（変更行の前後・呼び出し元・型定義）も読む。`,
    `変更ファイル:`,
    changedFiles.length ? changedFiles.map((f) => `- ${f}`).join('\n') : '- （一覧なし。diff から把握する）',
    ``,
    `## 仕様・要件コンテキスト`,
    specContext,
    ``,
    `## チェックコマンドの結果（一次証拠。失敗はそのまま不備の手がかり）`,
    checkResults,
    ``,
    `## 既に検出済み（重複報告しない。同じ箇所・同じ趣旨は出さない）`,
    seenList,
    ``,
    `## ルール`,
    `- 変更差分が原因の不備・漏れに集中する。差分外の既存問題は、この変更が新たに踏ませる/露出させる場合のみ報告する`,
    `- 推測だけで報告しない。コード/コミット/チェック出力で裏が取れる根拠を evidence に書く。実証が弱いものは severity を下げる`,
    `- 観点「${lens.key}」に該当しないものは他レンズに任せ、ここでは報告しない`,
    `- 各 finding に fixConfidence を付ける。high=機械的に確実に直せる。**仕様が期待挙動を明記していて、修正が単一箇所の明確な変更で済むものも high**（過度に medium に倒さない）。設計判断・仕様解釈・複数箇所に波及する変更を要するものは medium/low`,
    `- 本物の不備・漏れだけを返す。無理に件数を埋めない。該当なしなら findings は空配列でよい`,
    round > 0
      ? `- これは ${round + 1} 巡目。前巡で見落とした、より深い/間接的な不備に注力する`
      : ``,
  ]
    .filter((s) => s !== '')
    .join('\n')
}

const VERIFY_LENSES = [
  '再現性: この不備は実際に起きるか。指摘されたパスに到達し得るか。到達不能・既にガード済みなら反証する',
  '差分起因性: 本当にこの変更が原因か。git log / 差分で確認し、既存挙動を新規問題として報告していないか。既存問題なら反証する',
  '仕様妥当性: 要件解釈は正しいか。spec-completeness 系なら specContext と矛盾しないか。既に別の場所で満たされていないか。誤読なら反証する',
]

// 適応的投票: critical/high は誤判定の影響が大きいので 3 レンズ全パネル、
// medium/low は 1 レンズ（再現性）で安く判定する。検証コストの主因はここなので効果が大きい
function lensesFor(severity) {
  return severity === 'critical' || severity === 'high' ? VERIFY_LENSES : VERIFY_LENSES.slice(0, 1)
}

function verifyPrompt(f, verifyLens) {
  return [
    `次の指摘が本物かを敵対的に検証する。デフォルトの立場は「反証 (refuted=true)」。コード/コミット/チェック出力で本物だと確証できたときだけ refuted=false にする。`,
    ``,
    `## 検証対象の指摘`,
    `- 種別: ${f.category} / 重要度: ${f.severity}`,
    `- 箇所: ${f.file}:${f.line}`,
    `- 内容: ${f.description}`,
    `- 根拠: ${f.evidence}`,
    `- 提案修正: ${f.suggestedFix}`,
    ``,
    `## 対象`,
    `${scopeLabel} / 差分: \`${diffCmd}\``,
    ``,
    `## あなたの検証レンズ`,
    verifyLens,
    ``,
    `## 手順`,
    `1. ${f.file} を Read で読み、指摘箇所と周辺（呼び出し元・ガード・型）を実際に確認する`,
    `2. 検証レンズの観点で、指摘が誤り/無効になりうる理由を能動的に探す:`,
    `   - 既に正しく処理されている / 別の場所でガードされている`,
    `   - 差分起因ではなく既存挙動（git log で確認）`,
    `   - 仕様の誤読（specContext と矛盾、または既に満たされている）`,
    `   - 実際には到達不能なパス / 起こり得ない条件`,
    `3. 反証できなければ refuted=false。severity と fixConfidence は実態に合わせて補正してよい`,
    `   （機械的に直せる、または仕様が挙動を明記し単一箇所の明確な修正で済むなら high。設計判断・仕様解釈・複数箇所への波及を伴うなら medium/low。明確に直せるものを過度に medium に下げない）`,
  ].join('\n')
}

function keyOf(f) {
  // 安全網の粗いキー。意味的 dedup は dedup エージェントが担うので、ここは
  // ファイル + 近接行のみ（カテゴリは含めない）。同じ箇所を別カテゴリで報告した重複も寄せる
  const bucket = Math.floor((Number(f.line) || 0) / 6)
  return `${f.file}::${bucket}`
}

// 検出後・検証前に1枚挟む意味的 dedup/マージ。複数レンズが同じ根本欠陥を
// 別カテゴリ・別行で報告するため、ここで1件に統合しないと検証コストが膨らみ過剰報告になる
function dedupPrompt(raw, seenSummaries) {
  const rawList = raw
    .map(
      (f, i) =>
        `${i + 1}. [${f.severity}/${f.category}] ${f.file}:${f.line} — ${f.title}\n   ${f.description}`,
    )
    .join('\n')
  return [
    `複数の検出エージェントが同じ差分を別観点でレビューした「生の指摘」群がある。`,
    `これらには同じ根本欠陥を別の言い方・別カテゴリ・別行番号で報告した重複が多く含まれる。`,
    `重複を 1 件に統合し、本当に別個の欠陥だけを残すのがあなたの仕事。`,
    ``,
    `## 生の指摘（このラウンド）`,
    rawList,
    ``,
    `## 既に確定/検出済み（これらと同一の根本欠陥は出力しない）`,
    seenSummaries.length ? seenSummaries.map((s) => `- ${s}`).join('\n') : '（なし）',
    ``,
    `## 指示`,
    `- 統合してよいのは「同じ根本原因を指し、同じ修正で消える」指摘だけ。複数レンズが 1 つの欠陥を別の言い方・別カテゴリ・別行で報告した重複がこれに当たる`,
    `- **箇所が近い・症状が同じというだけで統合しない**。原因が異なり別々の修正が必要なものは、同じ関数・同じ数行内でも必ず別件として残す`,
    `  - 例: ある関数が誤って成功を返す件で、原因が「認可チェックの欠落」と「例外の握り潰し」の 2 つなら、症状は同じでも修正が別なので 2 件のまま残す`,
    `  - 例: 同じ関数の「期限判定の欠落」と「負値を 0 に丸めていない」は別の修正なので別件`,
    `- 統合する場合は: 最も高い severity / 最も具体的な description・evidence・suggestedFix / 最も低い（安全側の）fixConfidence を採る。category は最も本質的なものを選ぶ`,
    `- 「既に確定/検出済み」と同じ根本欠陥は出力しない（除外）`,
    `- 新しい問題を創作しない。元の指摘に無い欠陥を足さない。同一性の判断に迷えば該当ファイルを Read してよい`,
    `- **迷ったら統合せず残す**。取りこぼしより、重複が少し残る方が後段の検証で安全に処理できる`,
    `出力は統合後の findings 配列のみ。`,
  ].join('\n')
}

// ---- 本体 ----
const seenKeys = new Set() // 安全網の粗いキー（keyOf）
const seenSummaries = [] // dedup エージェント・検出エージェントに渡す既出サマリ
const confirmed = []
let dry = 0
let totalDetected = 0
let usedRounds = 0
let activeLenses = LENSES.slice() // 空振りレンズは次巡で間引く

for (let r = 0; r < ROUNDS; r++) {
  if (dry >= 1) break // dedup が効くので、新規ゼロの巡が 1 回あれば打ち切る
  if (activeLenses.length === 0) break // 全レンズが空振り済みなら巡回しても無駄
  usedRounds = r + 1
  const seenList = seenSummaries.length ? seenSummaries.join('\n') : '（なし）'

  // 検出: アクティブなレンズを並列。それぞれ自分で差分を取得して洗い出す（再現率優先で広く挙げる）
  const detections = await parallel(
    activeLenses.map((lens) => () =>
      agent(detectPrompt(lens, seenList, r), {
        label: `detect:${lens.key}:r${r + 1}`,
        phase: 'Detect',
        schema: FINDINGS_SCHEMA,
      }),
    ),
  )

  // レンズごとの結果（順序は activeLenses と対応）。0 件だったレンズは次巡で間引く
  const lensFindings = detections.map((d) => (d && Array.isArray(d.findings) ? d.findings : []))
  activeLenses = activeLenses.filter((lens, i) => lensFindings[i].length > 0)

  const found = lensFindings.flat()
  totalDetected += found.length

  if (found.length === 0) {
    dry++
    log(`巡 ${r + 1}: 検出なし（dry）`)
    continue
  }

  // 意味的 dedup/マージ（バリア）: 全レンズの生指摘を 1 枚のエージェントに集約し、
  // 同根の重複を統合・既出を除外。これを挟まないと同じ欠陥が複数件に膨れ検証コストが爆発する
  const mergedRes = await agent(dedupPrompt(found, seenSummaries), {
    label: `dedup:r${r + 1}`,
    phase: 'Detect',
    schema: FINDINGS_SCHEMA,
  })
  let fresh = mergedRes && Array.isArray(mergedRes.findings) ? mergedRes.findings : []

  // 安全網: dedup を通っても既出キーと衝突するものは落とす（過剰報告の二重防御）
  fresh = fresh.filter((f) => {
    const k = keyOf(f)
    if (seenKeys.has(k)) return false
    seenKeys.add(k)
    return true
  })

  if (fresh.length === 0) {
    dry++
    log(`巡 ${r + 1}: dedup 後の新規ゼロ（dry）`)
    continue
  }
  dry = 0

  // 検証コスト上限。超過分は重要度順に絞る（暗黙の切り捨てを避け log で明示）
  fresh.sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
  if (fresh.length > MAX_VERIFY_PER_ROUND) {
    log(
      `巡 ${r + 1}: dedup 後 ${fresh.length} 件のうち重要度上位 ${MAX_VERIFY_PER_ROUND} 件のみ検証（残りは割愛）`,
    )
    fresh = fresh.slice(0, MAX_VERIFY_PER_ROUND)
  } else {
    log(`巡 ${r + 1}: dedup 後 ${fresh.length} 件を敵対的検証へ（生 ${found.length} 件から統合）`)
  }

  // 次巡・dedup 用に既出サマリを記録
  for (const f of fresh) {
    seenSummaries.push(`[${f.severity}/${f.category}] ${f.file}:${f.line} — ${f.title}`)
  }

  // 検証: 各指摘を懐疑エージェントで並列反証。投票数は重要度で可変（lensesFor）。多数決で生存判定
  const verified = await parallel(
    fresh.map((f) => () =>
      parallel(
        lensesFor(f.severity).map((vl) => () =>
          agent(verifyPrompt(f, vl), {
            label: `verify:${f.category}:${f.file.split('/').pop()}`,
            phase: 'Verify',
            schema: VERDICT_SCHEMA,
          }),
        ),
      ).then((votes) => {
        const v = votes.filter(Boolean)
        if (v.length === 0) return null // 検証不能は安全側で破棄
        const refutedCount = v.filter((x) => x.refuted).length
        // 厳密過半数の反証で棄却。生存は refuted <= floor(alive/2)
        const survives = refutedCount <= Math.floor(v.length / 2)
        if (!survives) return null
        const live = v.filter((x) => !x.refuted)
        // 検出値と生存票を合わせて、severity は最も高い（保守的）値、
        // fixConfidence は最も低い（自動修正に慎重）値を採る。
        // 検証者が雑な値を返しても検出側の判断を失わず、安全側に倒すため
        const sevFinal = [f.severity, ...live.map((x) => x.severityAdjusted)].sort(
          (a, b) => sevRank(a) - sevRank(b),
        )[0]
        const fcRank = { high: 0, medium: 1, low: 2 }
        const fcFinal = [f.fixConfidence, ...live.map((x) => x.fixConfidenceAdjusted)].sort(
          (a, b) => fcRank[b] - fcRank[a],
        )[0]
        return {
          ...f,
          severity: sevFinal,
          fixConfidence: fcFinal,
          verification: {
            votes: v.length,
            refuted: refutedCount,
            reasons: live.map((x) => x.reason),
          },
        }
      }),
    ),
  )

  confirmed.push(...verified.filter(Boolean))
}

confirmed.sort((a, b) => sevRank(a.severity) - sevRank(b.severity))

return {
  scopeLabel,
  stats: {
    rounds: usedRounds,
    lenses: LENSES.map((l) => l.key),
    totalDetected,
    confirmedCount: confirmed.length,
  },
  confirmed,
}
