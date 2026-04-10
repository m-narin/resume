---
name: story-point
description: GitHub IssueにStory Pointを付与し、根拠コメントの追加とStatusの遷移を行う。「issueにpoint付与して」と依頼されたら使用する。
---

# Story Point 付与スキル

指定されたGitHub IssueにStory Pointを付与し、根拠コメントの追加とStatusの遷移を行う。

## 引数

- Issue番号またはURL（スペースまたはカンマ区切りで複数指定可能）
  - 単一: `/story-point 1234`
  - 複数: `/story-point 1234 1235 1236`
  - URL: `/story-point https://github.com/{OWNER}/{REPO}/issues/1234`

URLが渡された場合は、末尾のIssue番号を抽出して使用する。

## 前提条件

- 対象IssueがGitHub Projectに所属していること
- `gh` CLIに `project` スコープが付与されていること（`gh auth status` で確認可能）

## 手順

### 1. 全Issueの確認とsub issues解決

各Issue番号について内容を確認し、sub issuesの有無をチェックする:

```bash
gh issue view <ISSUE_NUMBER> --repo {OWNER}/{REPO}
```

```bash
gh api graphql -f query='
query($number: Int!) {
  repository(owner: "{OWNER}", name: "{REPO}") {
    issue(number: $number) {
      title
      subIssues(first: 50) {
        nodes {
          number
          title
          state
        }
      }
    }
  }
}' -F number=<ISSUE_NUMBER> --jq '.data.repository.issue.subIssues.nodes'
```

**sub issuesがある場合**:

- ユーザーに「#<ISSUE_NUMBER> にはsub issuesがあります。sub issuesにポイントを付与しますか？」と確認する
- 承認されたら、sub issuesのIssue番号を対象リストに差し替える（親Issueは除外）

**sub issuesがない場合**:

- そのIssue自体を対象とする

対象が確定したら、各IssueがProjectに所属していることを確認する。所属していない場合はスキップ対象としてユーザーに報告する。

### 2. 全IssueのStory Point判定

ポイントは `規模感 × 複雑さ` で決める。実装者のドメイン知識の有無は考慮しない。

基準の目安:

| Point | 規模感 | 複雑さ |
|-------|--------|--------|
| 1 | 数行の変更、単一ファイル | 自明な変更 |
| 2 | 小規模、1-2ファイル | 低い複雑さ |
| 3 | 中規模、複数ファイル | 標準的な複雑さ |
| 5 | 大規模、複数コンポーネント | 高い複雑さ、設計判断が必要 |
| 8 | 非常に大規模 | 非常に高い複雑さ、不確実性が高い |

チームで定義したStory Point基準のissueがあれば、そちらを参照して判定する。

### 3. ユーザーに一括確認

全Issueの判定結果を一覧で提示し、承認を得る。

| Issue  | タイトル | Story Point | 根拠（要約） |
| ------ | -------- | ----------- | ------------ |
| #1234 | xxx      | 3           | ...          |
| #1235 | yyy      | 5           | ...          |

ユーザーが個別に修正を指示した場合は、該当Issueのみ修正して再確認する。

### 4. Story Pointの付与（承認後、各Issueに実行）

#### 4a. IssueのプロジェクトアイテムIDを取得

```bash
gh api graphql -f query='
query($number: Int!) {
  repository(owner: "{OWNER}", name: "{REPO}") {
    issue(number: $number) {
      projectItems(first: 10) {
        nodes {
          id
          project { number }
        }
      }
    }
  }
}' -F number=<ISSUE_NUMBER> --jq '.data.repository.issue.projectItems.nodes[] | select(.project.number == {PROJECT_NUMBER}) | .id'
```

#### 4b. Story Pointを設定

```bash
gh project item-edit --project-id {PROJECT_ID} --id <ITEM_ID> --field-id {STORY_POINT_FIELD_ID} --number <STORY_POINT>
```

### 5. Issueにコメント追加（各Issueに実行）

根拠をIssueコメントとして追加する:

```markdown
## Story Point: <POINT>

### 根拠

- <根拠1>
- <根拠2>
- ...
```

```bash
gh issue comment <ISSUE_NUMBER> --repo {OWNER}/{REPO} --body "$(cat <<'EOF'
## Story Point: <POINT>

### 根拠

- <根拠1>
- <根拠2>
- ...
EOF
)"
```

### 6. StatusをRefinement Readyに遷移（各Issueに実行）

```bash
gh project item-edit --project-id {PROJECT_ID} --id <ITEM_ID> --field-id {STATUS_FIELD_ID} --single-select-option-id {REFINEMENT_READY_OPTION_ID}
```

### 7. 完了報告

全Issueの結果をまとめて報告する:

| Issue  | Story Point | コメントURL | Status           |
| ------ | ----------- | ----------- | ---------------- |
| #1234 | 3           | (URL)       | Refinement Ready |
| #1235 | 5           | (URL)       | Refinement Ready |
