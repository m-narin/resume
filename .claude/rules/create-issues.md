---
name: create-issues
description: デザインドックからGitHub sub issuesを作成する。「issue作成して」と依頼されたら使用する。
---

# Issue作成スキル

## 前提

ユーザーから以下が渡される:

- **parent issue**（既存のGitHub issue）
- **デザインドック**（`.md`ファイル等）

## 手順

### 1. デザインドックの読み込みと分析

渡されたデザインドックや既存仕様調査文書を読み込み、実装タスクを分析する。

### 2. sub issue分割の提案

以下の形式でユーザーに提案し、確認を取る:

```
下記のようにsub issuesを作成しますがよろしいですか？

| # | タイトル | 対応内容 |
|---|---------|---------|
| 1/N | 【〇〇】△△ 1/N | ・具体的な作業内容1<br>・具体的な作業内容2 |
| 2/N | 【〇〇】△△ 2/N | ・具体的な作業内容1<br>・具体的な作業内容2 |
| ... | ... | ... |
```

- タイトル・対応内容・分割粒度についてユーザーの承認を得てから作成に進む
- ユーザーからの修正指示があれば反映して再提案する

### 3. parent issueの「進め方」更新

承認後、parent issueのbodyに「進め方」セクションを追記する。以下を含める:

- sub issueの依存関係と実施順序
- ブランチ戦略（epicブランチの有無、PRの向き先）
- 並行着手可能なタスクの明示
- 依存関係の整理

```sh
gh issue edit {PARENT_ISSUE_NUMBER} --repo {OWNER}/{REPO} --body "$(cat <<'EOF'
{既存のbody内容}

## 進め方

1. #{SUB_ISSUE_1} タスク説明
2. #{SUB_ISSUE_2} タスク説明
   - #{SUB_ISSUE_3} 並行着手可能なタスク
   ...

### 依存関係

- #{SUB_ISSUE_X} → #{SUB_ISSUE_Y}（理由）
EOF
)"
```

### 4. sub issueの作成

承認された内容で `gh sub-issue create` を実行する。

> `gh sub-issue` は gh CLI の拡張機能 [yahsan2/gh-sub-issue](https://github.com/yahsan2/gh-sub-issue) を利用している。
> 未インストールの場合: `gh extension install yahsan2/gh-sub-issue`

```sh
gh sub-issue create --repo {OWNER}/{REPO} --parent {PARENT_ISSUE_NUMBER} --title "{ISSUE_TITLE}" --assignee "{ASSIGNEE}" --body "$(cat <<'EOF'
## Background

## Goal

## ToDo

-
-
-
EOF
)"
```

## タイトルの番号付け

複数のsub issueを作成する場合、タイトルの末尾に `M/N` 形式で番号を付ける（Mは何番目か、Nは総数）。

例:

- `【〇〇機能】DBマイグレーション 1/3`
- `【〇〇機能】API実装 2/3`
- `【〇〇機能】フロントエンド 3/3`
