---
title: AI エージェント (MCP)
description: MCP サーバーで kura を Claude Code などの AI エージェントに公開し、読み取りコマンドの --json 出力を使う。
---

kura は、AI エージェントの長期記憶になるよう設計されています。stdio
経由で [Model Context Protocol](https://modelcontextprotocol.io/) を
話すため、エージェントは通常のツール利用の一部として、ナレッジベースを
検索し、そこに書き込めます。

## Claude Code に接続する

```sh
claude mcp add kura -- kura mcp
```

ほかの MCP クライアントには、すぐ使える設定スニペットを出力できます。

```sh
kura mcp --print-config     # .mcp.json 用のエントリを表示
```

あとは `kura mcp` を実行するだけです。stdio で動き、ローカルに閉じて
います。ネットワークもアカウントも要りません。

## 公開ツール

| ツール | 目的 |
|---|---|
| `kura_query` | ハイブリッド検索（キーワード + セマンティック + リランク）。既定の検索ツール |
| `kura_search` | キーワード検索（FTS5 BM25） |
| `kura_get` | key またはタイトルでドキュメントを取得 |
| `kura_add` | ドキュメントを作成 |
| `kura_update` | 既存ドキュメントを更新 |
| `kura_list_tags` | タグ階層を一覧 |
| `kura_related` | 指定ドキュメントに関連するドキュメント（リンク + 類似度） |
| `kura_status` | ストアの統計 |

エージェントは通常、文脈を思い出すために `kura_query` を、ヒットの
周辺を探るために `kura_related` を、発見を書き戻すために `kura_add` /
`kura_update` を使います。kura はセッションをまたぐ永続的な記憶に
なります。

## 劣化動作

MCP ツールは CLI と同じ規則に従います。`kura_search` は LLM
プロバイダが無くても動き、`kura_query` はセマンティック検索やリランク
が利用できないときはキーワード結果側へフォールバックします
（[検索](/kura/ja/search/) を参照）。モデルが動いていないという理由
だけで、エージェントがハードな失敗を受け取ることはありません。

## どこでも `--json`

MCP ではなくスクリプトで kura を扱いたい場合、すべての読み取り
コマンドは `--json` に対応します。

```sh
kura query "SQLite の並行性" --json
kura get "今日のメモ" --json
kura status --json
```

JSON の形は安定した契約です（MCP ツールを支えるのと同じペイロード
です）。安心して上に積み上げられます。
