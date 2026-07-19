---
title: CLI
description: タスク別に整理した kura の全コマンド。共通の作法、--json 出力、終了コード。
---

`kura <command> [options]`。コマンド一覧は `kura --help`、各コマンドの
フラグは `kura <command> --help` で確認できます。

## 共通の作法

- **`--json`** — すべての読み取りコマンドは、整形テキストの代わりに
  機械可読な JSON を出力できます。スクリプト向けで、
  [MCP サーバー](/kura/ja/mcp/) からも利用されます。
- **ドキュメントの指定** — ドキュメントを取るコマンドは、doc key・
  `#key`・フルパス（`db/sqlite/メモ`）・一意なタイトル・一意な別名を
  受け付けます（例: `kura get "今日のメモ"` や `kura get #a1b2c3`）。
- **`NO_COLOR`** — 設定すると色付き出力を無効にします。
- **データの場所** — `KURA_HOME` はデータディレクトリ（既定
  `~/.kura`）を、`KURA_DB` は DB ファイルを上書きします。

## セットアップと健全性

| コマンド | 内容 |
|---|---|
| `kura init` | `~/.kura` の作成、トークナイザーのダウンロード、DB 作成 |
| `kura doctor` | SQLite・拡張・LLM プロバイダ・DB 整合性を診断 |
| `kura doctor --fix` | インデックス修復、孤立 GC、リンク再解決、embedding モデル変更の検出 |
| `kura status` | ストアの統計（件数・embedding カバレッジ・陳腐化候補・整理待ちの件数） |
| `kura config list\|get\|set` | `~/.kura/config.toml` の読み書き |

## ドキュメント

| コマンド | 内容 |
|---|---|
| `kura add <file>` | 追加。`-` で標準入力。`--path` / `--tags` / `--title` / `--bucket` |
| `kura get <ref>` | 表示（Markdown または `--json`）。`--as-of 2026-03-01` でその時点の内容を表示 |
| `kura edit <ref>` | エディタで編集（`general.editor` → `$EDITOR` → `vi`）。frontmatter でタイトル・パス・タグも変更 |
| `kura rm <ref>` | 削除 |
| `kura mv <ref> [<title>]` | リネームと移動（`--path`。相互リンクを書き換え）。`--prefix <old> <new>` でサブツリーを一括移動 |
| `kura ls` | 一覧。`--tag` / `--bucket` / `--prefix` / `--sort` / `--stale` / `--unfiled` / `--untagged` |
| `kura history <ref>` | 更新履歴の一覧 — 編集のたびに直前の版が保存されます。`show <ref> <rN>` で内容表示、`restore <ref> <rN>` で本文を復元（復元自体もやり直せます） |
| `kura changes --since <t>` | 指定時点以降に作成・更新されたドキュメントを一覧（`7d` や `2026-07-01`）。リネームや移動も更新履歴から検出 |
| `kura clip <url>` | Web ページを LLM で整形して取り込み。`clip.path`（既定 `clips`）配下に保存 |
| `kura export --dir <d>` | frontmatter 付き Markdown で書き出し。パスはサブディレクトリになる |
| `kura import <dir>` | `kura_key` でラウンドトリップ（更新 or 新規）。サブディレクトリはパスになる |

## 検索

| コマンド | モード | 補足 |
|---|---|---|
| `kura search <q>` | キーワード | FTS5 BM25。常に利用可能。< 100ms |
| `kura vsearch <q>` | セマンティック | ローカル embedding に対するベクトル KNN |
| `kura query <q>` | ハイブリッド | キーワード + ベクトルを融合し、ローカル LLM でリランク |
| `kura ask <質問>` | 回答生成 | 上位ヒットを根拠に質問へ回答し、出典を `[1]`, `[2]` … で引用 |
| `kura embed` | — | embedding が無いドキュメントを（再）生成 |

モードの違いと、LLM プロバイダが無いときの劣化動作は
[検索](/kura/ja/search/) を参照してください。

## 整理

| コマンド | 内容 |
|---|---|
| `kura bucket ls\|add\|rm\|mv` | Bucket を管理（`mv` でリネーム） |
| `kura tag ls` | タグ一覧。`--tree` で階層表示 |
| `kura tag add\|rm <doc> <tag>…` | ドキュメントにタグを追加・削除 |
| `kura tag mv <old> <new>` | タグ（サブツリー）をリネーム・統合 |
| `kura tag gc` | どのドキュメントも使っていないタグを削除 |
| `kura link ls <ref>` | アウトリンク・バックリンク・2 ホップリンク |
| `kura alias ls\|add\|rm <doc> <alias>…` | 別名（別タイトル）を管理。`[[別名]]` リンクが解決され、検索にもヒットする |
| `kura triage` | バックログ（未整理・タグなしのドキュメント）を整理。ドキュメントごとに重複マージ・タイトル・タグ・path・関連 `[[リンク]]` を提案。`--apply` / `--json` / `--steps`。「まず放り込み、あとで整理する」ワークフロー |
| `kura audit [contradictions\|dupes\|tags\|links]` | ナレッジベースの健全性チェック。引数なしで 4 種をレポート表示。`dupes` / `tags` は `--apply` 可、`contradictions` は LLM 必須（exit 4）。各サブコマンドで `--json` |

## サーバーとエージェント連携

| コマンド | 内容 |
|---|---|
| `kura browser` | `http://127.0.0.1:7578` でブラウザ UI を提供 |
| `kura mcp` | AI エージェント向けに stdio で MCP サーバーを起動 |
| `kura mcp --print-config` | `.mcp.json` 用スニペットを表示 |
| `kura skills install` | `kura-cli` エージェントスキル（AI エージェント向け CLI ガイド）を `~/.agents/skills` にインストール（`--dir` で変更可） |
| `kura skills show` | スキルを標準出力に表示（`kura skills uninstall` で削除） |

## 終了コード

| コード | 意味 |
|---|---|
| `0` | 成功 |
| `1` | エラー（一意制約違反などの競合を含む） |
| `2` | 使い方エラー（引数が不正） |
| `3` | 見つからない（該当ドキュメントなし） |
| `4` | LLM プロバイダが利用不可 |

スクリプトはこれらに依存できます。終了コード `4` は「その機能は
モデルを必要とし、どれにも到達できなかった」ことを意味し、通常の
エラーとは区別されます。
