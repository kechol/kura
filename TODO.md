# kura 実装 TODO

SPEC.md に基づく実装タスク一覧。マイルストーン（M0〜M7）は依存順。各マイルストーン内のタスクは概ね並列実装可能で、SubAgent への移譲単位を想定している。**各タスクは SPEC.md の該当セクション（§）を必ず読んでから着手すること。**

## M0: プロジェクト基盤

- [x] `bun init` 相当のセットアップ: `package.json`（scripts は SPEC §12.1 準拠）、`tsconfig.json`（strict）、Biome 設定、`.gitignore`（`dist/`, `tmp/`, `release/`）
- [x] 依存導入: `sqlite-vec`, `@modelcontextprotocol/sdk`, `@mozilla/readability`, `linkedom`, `turndown`, `preact`, `wouter`, `markdown-it`, `highlight.js`, `dompurify`, `d3-force`（クライアント系は devDeps）
- [x] `src/cli/index.ts` エントリポイント + `src/cli/args.ts`（`util.parseArgs` ベースのサブコマンドディスパッチ、`--help` / `--version` / `--json` 共通処理、終了コード規約 §7）
- [x] `src/core/paths.ts`（`KURA_HOME` 解決）+ `src/core/config.ts`（TOML 読み書き、§11 の既定値）
- [x] CI: GitHub Actions で `bun run check` + `bun test`（PR トリガー）

## M1: DB 層と拡張ブートストラップ

- [x] `src/core/db.ts`: macOS での `Database.setCustomSQLite()`（`process.arch` でパス解決、§2.1）、WAL/foreign_keys PRAGMA、シングルトン接続
- [x] `src/core/bootstrap.ts`: sqlite-vec をバイナリ埋め込み（`with { type: "file" }`）→ `~/.kura/lib/<ver>/` へ展開してロード。sqlite-vaporetto + 形態素モデルを GitHub Releases から SHA256 検証付きダウンロード（§2.1）。ロード失敗時の trigram フォールバック判定と `meta` への記録
- [x] マイグレーションランナー（`PRAGMA user_version`）+ `src/core/migrations/001_init.sql`（§3.1 全スキーマ。FTS の tokenize 句はブートストラップ結果で動的組み立て）
- [x] `kura init` コマンド（§7.1）
- [x] `kura doctor`（診断のみ。--fix は M6）: SQLite/拡張/モデルファイル/Ollama・LM Studio 到達性/必要モデル有無のチェックリスト表示（§7.1）
- [x] テスト: メモリ DB でマイグレーション適用、拡張ロード（CI は Linux なので linux-x64 バイナリで検証）、trigram フォールバック

## M2: ドキュメント CRUD・タグ・リンク

- [x] `src/core/wiki.ts`: `[[タイトル]]` / `[[タイトル|表示]]` / `#tag/path` のパーサ（コードブロック内は無視）。単体テスト充実
- [x] `src/core/chunker.ts`: ブレークポイントスコアリング分割（§5.2）。日本語 fixture でテスト
- [x] `src/core/documents.ts`: CRUD リポジトリ。保存トランザクションで FTS/links/document_tags/chunks を同期（§3.2）。doc_key 生成、content_hash 差分検知、未解決リンク自動解決（§10.1）
- [x] `src/core/tags.ts` / `links.ts` / `buckets.ts`
- [x] コマンド: `add`（ファイル/stdin/frontmatter パース §4）、`get`（--pretty/--raw/--lines、access_count 更新）、`edit`（$EDITOR ラウンドトリップ）、`rm`、`mv`（リンク張り替え）、`ls`（フィルタ・ソート・--stale）
- [x] コマンド: `export` / `import`（frontmatter ラウンドトリップ §4）、`bucket ls/add/rm/mv`
- [x] コマンド: `tag ls/--tree`, `tag add/rm/mv/gc`, `link ls`（バックリンク・2ホップ SQL）, `link broken`
- [x] `src/cli/render.ts`: Markdown → ANSI レンダラ（見出し/強調/コード/リスト/引用。TTY 判定、NO_COLOR 対応）
- [x] e2e テスト: init → add → ls → get → edit → mv → rm のフロー

## M3: 検索

- [x] `src/core/search/keyword.ts`: `vaporetto_or_query`/`and_query` + bm25 重み付け + snippet（§5.4）。trigram フォールバック時のクエリ組み立て
- [x] `src/core/llm/provider.ts` + `ollama.ts` + `lmstudio.ts`: auto 検出（TTL 60s）、`/v1/embeddings` バッチ、`/v1/chat/completions`（§6）。モックプロバイダ（テスト用）
- [x] `src/core/llm/cache.ts`: llm_cache テーブルの read-through キャッシュ
- [x] `src/core/search/vector.ts`: クエリ embedding → `chunks_vec` KNN → ドキュメント集約（max）。未 embedding チャンクの検出と自動バックフィル（§5.3）
- [x] `kura embed`（--all）: バッチ embedding（プログレス表示、中断再開可能 = embedded_at ベース）
- [x] `src/core/search/hybrid.ts`: RRF 融合（k=60、重み設定）+ ポジション加重ブレンド（§5.1）
- [x] `src/core/search/rerank.ts`: chat completions での yes/no 判定（並列実行、キャッシュ、プロバイダ不在時スキップ）
- [x] `src/core/search/expand.ts`: `--expand` クエリ展開（キャッシュ必須）
- [x] コマンド: `search` / `vsearch` / `query`（§7.3。劣化動作: プロバイダ不通でも FTS で応答 + 警告）
- [x] 日本語検索回帰テスト: fixtures 30件で BM25 順位・ハイライト・ハイブリッド結果を検証（§14）

## M4: MCP サーバー

- [x] `src/server/mcp.ts`: stdio トランスポート、8 ツール（§9 の表）。description にエージェント向け利用ガイダンスを記述
- [x] `kura mcp` コマンド + `--print-config`（claude mcp add / .mcp.json スニペット出力）
- [x] MCP e2e テスト（SDK のインメモリクライアントで各ツールを呼ぶ）

## M5: ブラウザ UI

- [x] `src/server/http.ts`: Bun.serve、ポートフォールバック（EADDRINUSE +1 ×10）、127.0.0.1 バインド、SPA アセット埋め込み配信（`with { type: "file" }`、SPA フォールバックルーティング）、`--no-open` / OS 別ブラウザ起動（§8.1）
- [x] `src/server/api.ts`: REST エンドポイント一式（§8.2）。CRUD は core リポジトリを再利用
- [x] SPA 基盤: Preact + wouter、レイアウト（サイドバー: Bucket/タグツリー）、ダーク/ライトテーマ
- [x] ドキュメント一覧・詳細ページ: markdown-it + highlight.js レンダリング、`[[リンク]]` の内部リンク化、DOMPurify（HTML ドキュメント）、Mermaid 遅延ロード、右サイドバー（バックリンク・2ホップ・タグ・参照数・更新日）（§8.3）
- [x] 編集ページ（textarea + 保存 → PUT /api/docs/:key）
- [x] 検索ページ（3モード切替、スニペットハイライト）、タグブラウザ
- [x] ナレッジグラフページ: d3-force、タグ色分け、陳腐化ノード減光、孤立ノード切替（§8.3）
- [x] ホーム: 最近更新・よく参照・陳腐化候補・統計
- [x] `scripts/build-html.ts` + `build:client` パイプライン確立（compile 前提の成果物検証）

## M6: clip・ガーデニング・自己修復

- [x] `src/core/clip/extract.ts`: fetch（timeout 30s）→ readability + linkedom 本文抽出
- [x] `src/core/clip/format.ts`: LLM 整形（タイトル抽出込み）/ `--no-llm` turndown フォールバック
- [x] `kura clip` コマンド（§7.5: タグ提案、URL 重複検知、--dry-run）
- [x] `src/core/gardening.ts` + `kura tag suggest`（--untagged/--apply、既存タグ優先プロンプト）、`kura tag audit`（編集距離 + embedding 類似の統合候補、対話適用）（§10.3）
- [x] `src/core/stale.ts`: 陳腐化スコア（§10.4）。`ls --stale` / `status` / ブラウザホームへ組み込み
- [x] `kura doctor --fix`: FTS リビルド、孤立チャンク/vec GC、content_hash 再計算、未解決リンク再解決、拡張再取得、embedding モデル変更検知 → 再 embedding 案内（§10.2）
- [x] `kura status`（§7.1 の統計一式、--json）

## M7: 配布

- [x] `bun build --compile` 検証（darwin-arm64 実機）: 拡張展開 → ロード → 全コマンド動作のスモークテスト
- [x] GitHub Actions リリースワークフロー: 5 ターゲットのクロスコンパイル、ZIP + install.sh（quarantine 除去）/ install.ps1、`gh release create`（参考 gist 方式、§12.1）。Bun バージョン固定
- [x] README.md: インストール手順（Homebrew SQLite 前提条件含む）、クイックスタート、Ollama モデルの pull 手順、MCP 設定例
- [x] バイナリサイズ・起動時間・検索レイテンシの計測と §13 目標の確認

## 実装上の注意（SubAgent 向け申し送り）

1. **macOS では `Database.setCustomSQLite()` を最初の `Database` 生成前に呼ぶこと**。怠るとネイティブクラッシュ（SIGSEGV）する
2. FTS の同期は SQL トリガーではなくリポジトリ層で行う（tags 列の合成があるため）。documents を直接 UPDATE する経路を作らないこと
3. LLM 依存機能はすべて「プロバイダ不在でも壊れない」こと（劣化動作 + doctor への誘導）。テストはモックプロバイダで書く
4. 検索・チャンク処理のテストは必ず日本語 fixture を使うこと。英語のみのテストは不合格
5. `Bun.serve` の API ハンドラと CLI コマンドは必ず core のリポジトリ/サービス層を共有し、ロジックを重複させない
6. コミットは機能単位で分割（Git 規約: ブランチ `kechol/{kebab-case}`）

## 残タスク（実機・環境依存の検証）

- [ ] darwin-arm64 実機での vaporetto 実ロード検証（`kura init` → `kura doctor`。CI では linux-x64 で `KURA_TEST_DOWNLOAD=1` の実ダウンロード + ロード統合テストを実行。ローカル実行は外部ネイティブコード実行の承認が必要だったため未実施）
- [ ] Ollama 実プロバイダでの `vsearch` / `query` エンドツーエンド確認（`ollama pull` 3 モデル → `kura embed` → `kura query`。§13 の query < 5s 計測を含む）
- [ ] GitHub リモート作成後: CI（PR トリガー）とリリースワークフロー（タグ push）の実走確認
