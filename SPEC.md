# kura — ローカルナレッジ管理 CLI 仕様書

## 1. 概要

`kura` は、Markdown/HTML ドキュメントを SQLite に格納し、人間と AI エージェントの双方がクエリーできるローカルナレッジ管理 CLI である。

- **人間向け**: CLI での検索・閲覧・編集、`kura browser` によるブラウザ UI（ドキュメント閲覧・ナレッジグラフ可視化）
- **AI エージェント向け**: `kura mcp` によるローカル MCP サーバー、全コマンドの `--json` 出力
- **検索**: 日本語（CJK）対応のハイブリッド RAG 検索 — FTS5 キーワード検索（sqlite-vaporetto）+ セマンティック検索（sqlite-vec + ローカル embedding）+ ローカル LLM リランク
- **配布**: Bun 製シングルバイナリ

### 1.1 設計原則（確定事項）

| 項目                          | 決定                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| データの正（source of truth） | **SQLite**。本文も DB に格納。ファイルは import/export の入出力に過ぎない                                                       |
| DB 配置                       | **グローバル単一 DB**（`~/.kura/kura.db`）。`KURA_HOME` 環境変数で上書き可                                                      |
| 想定規模                      | **〜1万ドキュメント**。ANN 不要、sqlite-vec のブルートフォース KNN で十分                                                       |
| LLM プロバイダ                | **Ollama 優先 + 自動検出**。無ければ LM Studio にフォールバック。LLM なしでも劣化動作（キーワード検索のみ）で全機能が壊れない   |
| ドキュメント整理              | 階層フォルダなし。**Bucket（大分類）+ 階層タグ（`tech/db/sqlite`）+ 相互リンク（`[[タイトル]]`）** で自己組織化（Cosense 方式） |
| 自己修復                      | 未解決リンクの自動解決、インデックス整合性修復、タグ・ガーデニング、陳腐化検出を備える                                          |

### 1.2 非ゴール

- マルチユーザー・同期・クラウド機能（ローカル単一ユーザー専用）
- ファイルシステム監視による自動インデックス（取り込みは明示的な `add` / `import` / `clip` / MCP 経由）
- 10万件超のスケール対応（量子化・パーティショニングは設計対象外）
- WYSIWYG エディタ（編集は `$EDITOR` またはブラウザのプレーンエディタ）

---

## 2. 技術スタック

| レイヤ                                  | 技術                                                                      | 備考                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| ランタイム                              | Bun（`bun build --compile` でシングルバイナリ化）                         | Bun ≥ 1.3 安定版。canary の dlopen リグレッション（oven-sh/bun#30717）を踏まないようビルドバージョンを固定 |
| DB                                      | SQLite（WAL モード）                                                      | macOS では `Database.setCustomSQLite()` で Homebrew SQLite を指定（必須、§2.1）                            |
| キーワード検索                          | FTS5 + [sqlite-vaporetto](https://github.com/hotchpotch/sqlite-vaporetto) | 日本語形態素解析トークナイザー。`vaporetto_or_query()` / `vaporetto_and_query()` でクエリ生成              |
| ベクトル検索                            | [sqlite-vec](https://github.com/asg017/sqlite-vec)                        | npm パッケージが Bun を公式サポート。`vec0` 仮想テーブル                                                   |
| embedding                               | Ollama / LM Studio の OpenAI 互換 `/v1/embeddings`                        | 既定モデル: `qwen3-embedding:0.6b`（1024 次元・多言語）                                                    |
| リランク                                | Ollama / LM Studio の `/v1/chat/completions`                              | 既定モデル: `dengcao/Qwen3-Reranker-0.6B`。yes/no 判定（logprobs が取れる場合は信頼度に利用）              |
| 生成（clip 整形・タグ提案・クエリ展開） | 同上 chat completions                                                     | 既定モデル: `qwen3:4b`（32GB Mac で余裕をもって動作）                                                      |
| ブラウザ UI                             | Bun.serve + Preact SPA（バイナリに埋め込み）                              | markdown-it + highlight.js + DOMPurify、グラフは d3-force                                                  |
| MCP                                     | `@modelcontextprotocol/sdk`（stdio）                                      |                                                                                                            |
| CLI 引数パース                          | Node.js ネイティブ `util.parseArgs`                                       | commander 等は使わない（バイナリサイズ削減）                                                               |

### 2.1 SQLite 拡張のロード戦略（重要）

ネイティブ拡張（.dylib/.so/.dll）はシングルバイナリに直接埋め込んで dlopen できないため、以下の戦略をとる:

1. **sqlite-vec**: バイナリに `with { type: "file" }` で埋め込み、初回起動時に `~/.kura/lib/<kuraバージョン>/` へ展開してから `loadExtension()`。npm の `sqlite-vec-darwin-arm64` 等のプリビルドを利用
2. **sqlite-vaporetto**: 拡張 + 形態素モデル（`bccwj-suw+unidic_pos+kana.model.zst`、大容量）は埋め込まず、**初回起動時（または `kura doctor --fix`）に GitHub Releases から `~/.kura/lib/<バージョン>/` へダウンロード**。SHA256 検証必須
3. **macOS**: 最初の `Database` 生成前に必ず `Database.setCustomSQLite()` を呼ぶ。パスは `process.arch` で解決:
   - arm64: `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`
   - x64: `/usr/local/opt/sqlite/lib/libsqlite3.dylib`
   - 存在しない場合は `kura doctor` が `brew install sqlite` を案内

**劣化動作（self-healing の一部）**: vaporetto がロードできない環境（例: macOS x64 はバイナリ未配布）では、FTS5 の `trigram` トークナイザーに自動フォールバックする。`meta` テーブルに使用トークナイザーを記録し、環境が変わったら `doctor` が再インデックスを提案する。

### 2.2 対応プラットフォーム

| ターゲット              | vaporetto                   | 備考                                 |
| ----------------------- | --------------------------- | ------------------------------------ |
| darwin-arm64            | ✅                          | 第一級サポート（開発・主要利用環境） |
| linux-x64 / linux-arm64 | ✅                          |                                      |
| darwin-x64              | ❌ → trigram フォールバック | vaporetto バイナリ未配布のため       |
| windows-x64             | ✅                          | ベストエフォート                     |

---

## 3. データモデル

### 3.1 スキーマ（マイグレーション v1）

`PRAGMA user_version` でスキーマバージョンを管理し、起動時に不足マイグレーションを自動適用する。

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Bucket: ナレッジの大分類（例: internal / external / personal）
CREATE TABLE buckets (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,          -- 小文字英数と - のみ
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO buckets (name, description) VALUES ('main', 'Default bucket');

CREATE TABLE documents (
  id               INTEGER PRIMARY KEY,
  doc_key          TEXT NOT NULL UNIQUE,     -- 8文字の短縮ID（内容+乱数のhash、qmd の docid 相当）
  bucket_id        INTEGER NOT NULL REFERENCES buckets(id),
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  content_type     TEXT NOT NULL DEFAULT 'markdown',  -- 'markdown' | 'html'
  source_url       TEXT,                     -- clip 元 URL 等
  content_hash     TEXT NOT NULL,            -- sha256。変更検知・再embedding判定に使用
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,                     -- get / MCP get / 検索結果本文取得で更新
  access_count     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (bucket_id, title)                  -- タイトルは Bucket 内で一意（[[リンク]] 解決のため）
);
CREATE INDEX idx_documents_bucket ON documents(bucket_id);
CREATE INDEX idx_documents_updated ON documents(updated_at);

-- タグ: スラッシュ区切りで階層化（'tech/db/sqlite'）。タグ自体の実体テーブル
CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE                  -- 正規化: 小文字化・前後スラッシュ除去・連続スラッシュ圧縮
);

CREATE TABLE document_tags (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto'（LLM付与）
  PRIMARY KEY (document_id, tag_id)
);

-- 相互リンク: 本文中の [[タイトル]] を保存時に抽出して同期
CREATE TABLE links (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_id    INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  target_title TEXT NOT NULL,                -- [[...]] の生テキスト。target_id が NULL なら未解決リンク
  UNIQUE (source_id, target_title)
);
CREATE INDEX idx_links_target ON links(target_id);
CREATE INDEX idx_links_unresolved ON links(target_title) WHERE target_id IS NULL;

-- チャンク: embedding の単位（§5.2）
CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  start_offset INTEGER NOT NULL,             -- 本文中の開始位置（行番号ジャンプ用）
  embedded_at  TEXT,                         -- NULL = embedding 未生成（バックフィル対象）
  UNIQUE (document_id, seq)
);

-- FTS5: 標準テーブル（highlight/snippet を使うため contentless にしない。1万件規模なら容量は許容）
-- tokenize はセットアップ時に vaporetto / trigram を決定して構築（§2.1）
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, content, tags,
  tokenize='vaporetto model {KURA_HOME}/lib/{ver}/bccwj-suw+unidic_pos+kana.model.zst'
);
-- 同期はトリガーではなくリポジトリ層が同一トランザクション内で行う（tags 列の合成があるため）

-- sqlite-vec: チャンク embedding（次元数は設定から。既定 1024）
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,              -- chunks.id と対応
  embedding float[1024]
);

-- LLM 応答キャッシュ（クエリ展開・リランクスコア・タグ提案）
CREATE TABLE llm_cache (
  cache_key  TEXT PRIMARY KEY,               -- sha256(purpose + model + input)
  purpose    TEXT NOT NULL,                  -- 'expand' | 'rerank' | 'tag' | 'clip'
  value      TEXT NOT NULL,                  -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- システムメタ情報
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,                    -- 'embedding_model', 'embedding_dimensions',
  value TEXT NOT NULL                        -- 'fts_tokenizer', 'schema_version' など
);
```

### 3.2 整合性ルール

- `documents` の作成・更新・削除は必ず単一トランザクションで `documents_fts` / `links` / `document_tags` / `chunks` を同期する
- 本文更新時: `content_hash` が変わった場合のみチャンク再分割 + `chunks_vec` の該当行削除 + `embedded_at = NULL`（embedding は遅延バックフィル、§5.3）
- タイトル変更・新規作成時: `links.target_title` が一致する未解決リンクを自動解決し、旧タイトルへのリンクは張り替える（`kura mv` 参照）
- embedding モデルまたは次元数の変更を検知したら（`meta` と config の不一致）、`chunks_vec` を再作成して全件再 embedding を促す（`doctor` が検出、`kura embed --all` で実行）

---

## 4. ドキュメントの記法

- 本文は Markdown（GFM）。`content_type = 'html'` の生 HTML も格納可
- **Wiki リンク**: `[[タイトル]]` または `[[タイトル|表示テキスト]]`。保存時に `links` へ抽出。Bucket 内のタイトルと大文字小文字を無視して照合
- **ハッシュタグ**: 本文中の `#tech/db/sqlite` 形式は保存時に `document_tags(source='manual')` として抽出（frontmatter の tags と統合）
- **frontmatter**（import/export 時のラウンドトリップに使用）:

```markdown
---
kura_key: a1b2c3d4 # export 時に付与。import 時にあれば更新扱い
title: SQLite の WAL モード
bucket: main
tags: [tech/db/sqlite, tech/performance]
source_url: https://example.com/wal
created_at: 2026-07-07T10:00:00Z
updated_at: 2026-07-07T10:00:00Z
---

本文...
```

---

## 5. 検索パイプライン

qmd のアーキテクチャを踏襲し、3段階の検索モードを提供する。

### 5.1 検索モード

| コマンド       | 方式                    | レイテンシ目標                   | LLM 要否             |
| -------------- | ----------------------- | -------------------------------- | -------------------- |
| `kura search`  | FTS5 BM25 のみ          | < 100ms                          | 不要                 |
| `kura vsearch` | ベクトル KNN のみ       | < 500ms（クエリ embedding 込み） | embedding            |
| `kura query`   | ハイブリッド + リランク | < 5s                             | embedding + reranker |

`kura query` のパイプライン:

```
クエリ
  ├─ (オプション --expand) LLM クエリ展開: 元クエリ(重み2) + バリアント2件。llm_cache にキャッシュ
  ├─ FTS5: WHERE documents_fts MATCH vaporetto_or_query(?) → bm25() 上位50
  └─ vec:  クエリ embedding → chunks_vec KNN 上位50 → ドキュメント単位に max スコアで集約
  ↓
RRF 融合（k=60、重みは config の keyword_weight / vector_weight）
  ↓ 上位20（rerank_top_k）
リランク: 各候補チャンクを chat completions で yes/no 判定（並列、llm_cache 利用）
  ↓
最終スコア = ポジション加重ブレンド（qmd 方式）:
  RRF 順位 1–3:  RRF 75% + rerank 25%
  RRF 順位 4–10: RRF 60% + rerank 40%
  RRF 順位 11+:  RRF 40% + rerank 60%
```

**劣化動作**: embedding プロバイダ不通なら `query` は FTS のみ + 警告表示。reranker 不在なら RRF 結果をそのまま返す。エラーで落とさない。

### 5.2 チャンク分割（qmd 方式の簡略版)

- 目標チャンクサイズ: **1600 文字**（日本語 ≈ 900〜1000 トークン相当）、オーバーラップ 15%
- ブレークポイント優先度: H1(100) > H2(90) > H3(80) > コードブロック境界(80、ブロック内では分割しない) > 水平線(60) > 空行(20) > 行末(1)
- 目標サイズからの距離によるスコア減衰: `finalScore = baseScore × (1 - (distance/400)² × 0.7)`
- チャンク先頭に `# {title} > {直近見出し}` のコンテキストヘッダを付与してから embedding する（検索精度向上）

### 5.3 embedding の遅延バックフィル

`add` / `edit` / `clip` は embedding 生成を**ブロックしない**（`embedded_at = NULL` で保存のみ）。生成タイミング:

1. `kura embed` の明示実行
2. `vsearch` / `query` 実行時、未 embedding チャンクが存在すれば検索前に自動バックフィル（件数が多い場合は警告を出して検索は実行し、`kura embed` を案内）
3. `kura browser` / `kura mcp` サーバー起動中のアイドル時バックグラウンド処理

### 5.4 FTS クエリ規約

- vaporetto 使用時: ユーザー入力を `vaporetto_or_query()` で OR クエリ化して BM25 でランキング（`search --all` で AND）。`bm25(documents_fts, 5.0, 1.0, 3.0)` で title / content / tags に重み付け
- trigram フォールバック時: 入力をエスケープして `"..."` フレーズ + 空白区切り OR
- スニペットは `snippet(documents_fts, 1, '**', '**', '…', 20)` で生成

---

## 6. LLM プロバイダ抽象

```typescript
interface LLMProvider {
  name: "ollama" | "lmstudio";
  isAvailable(): Promise<boolean>; // Ollama: GET /api/tags, LM Studio: GET /v1/models
  hasModel(model: string): Promise<boolean>;
  embed(
    texts: string[],
    model: string,
    dimensions?: number,
  ): Promise<Float32Array[]>; // POST /v1/embeddings（バッチ）
  chat(
    messages: Message[],
    model: string,
    opts?: { temperature?: number },
  ): Promise<string>; // POST /v1/chat/completions
}
```

- 解決順序（`provider = "auto"`）: Ollama（`http://localhost:11434`）→ LM Studio（`http://localhost:1234`）→ none
- 検出結果はプロセス内キャッシュ（TTL 60秒）。`none` の場合、LLM 依存機能は明確なエラーメッセージ + `kura doctor` への誘導を返す
- 既定モデル:
  - embedding: `qwen3-embedding:0.6b`（1024次元。日本語精度優先の代替として `kun432/cl-nagoya-ruri-large` を config で指定可。次元数も config で追随）
  - reranker: `dengcao/Qwen3-Reranker-0.6B`
  - generation: `qwen3:4b`
- すべて 32GB Mac で同時ロード可能なサイズ（合計 < 4GB）

---

## 7. CLI コマンド仕様

グローバル規約:

- すべての読み取り系コマンドは `--json` で機械可読出力（エージェント連携用）
- ドキュメント指定子 `<doc>`: `doc_key`（8文字）、`#` プレフィックス付き key、または Bucket 内で一意なタイトル
- `--bucket <name>`: 対象 Bucket（省略時は config の `default_bucket`。検索系は省略時全 Bucket）
- 終了コード: 0=成功, 1=一般エラー, 2=引数エラー, 3=対象なし, 4=LLM プロバイダ利用不可
- TTY 出力時は Markdown を ANSI レンダリング（見出し・強調・コードブロック・リスト。自前実装の軽量レンダラ）。パイプ時は生テキスト

### 7.1 セットアップ・診断

```
kura init                     # ~/.kura/ 初期化、拡張の展開/ダウンロード、DB 作成、config 生成
kura doctor [--fix]           # 診断: Homebrew SQLite / 拡張ロード / vaporetto モデル / Ollama・LM Studio 到達性
                             #       必要モデルの有無（無ければ `ollama pull ...` を案内）/ DB 整合性
                             #       FTS・vec インデックス整合 / embedding モデル変更検知
                             # --fix: 拡張再取得、FTS リビルド、孤立チャンク GC、未解決リンク再解決
kura status [--json]          # 統計: Bucket別件数、タグ数、embedding カバレッジ、陳腐化ドキュメント数、DB サイズ
kura config [get|set|list]    # 設定の読み書き（~/.kura/config.toml）
```

### 7.2 ドキュメント CRUD

```
kura add <file>... [--bucket b] [--tags t1,t2] [--title T] [--type markdown|html]
kura add -                    # stdin から。--title 必須
kura get <doc> [--pretty|--raw] [--json] [--lines 50:100]
                             # access_count++ / last_accessed_at 更新
kura edit <doc>               # 本文を一時ファイルに書き出し $EDITOR で編集 → 保存時に再パース
kura rm <doc> [--force]
kura mv <doc> <新タイトル>     # リネーム。既存の [[旧タイトル]] リンクを自動で張り替え
kura ls [--bucket b] [--tag t] [--sort updated|created|accessed|title] [--stale] [--limit n]
kura export [--bucket b] [--tag t] --dir <path>   # frontmatter 付き Markdown で書き出し（バックアップ兼用）
kura import <dir|file>... [--bucket b]            # frontmatter の kura_key があれば更新、無ければ新規
```

### 7.3 検索

```
kura search  "クエリ" [--bucket b] [--tag t] [--all] [--limit 20] [--json]
kura vsearch "クエリ" [--bucket b] [--tag t] [--limit 20] [--json]
kura query   "クエリ" [--bucket b] [--tag t] [--expand] [--limit 10] [--json]
kura embed   [--all]          # 未処理チャンクの embedding 生成（--all で全件強制再生成）
```

検索結果表示: `doc_key、タイトル、Bucket、タグ、スコア、スニペット（マッチ箇所ハイライト）`。`--json` では `{key, title, bucket, tags, score, snippet, source}` の配列。

### 7.4 タグ・リンク・Bucket

```
kura tag ls [--tree]                # タグ一覧（--tree で階層表示 + 件数）
kura tag add <doc> <tag>...
kura tag rm <doc> <tag>...
kura tag mv <旧path> <新path>       # リネーム/統合（子孫タグも一括移動）。統合先が既存なら merge
kura tag suggest [--doc d] [--untagged] [--apply]
                                   # LLM がタグを提案。--apply なしは提案表示のみ（対話確認して適用）
kura tag gc                         # どのドキュメントにも付いていないタグを削除
kura tag audit [--apply]            # ガーデニング: 類似タグ検出（編集距離 + embedding 類似度）と統合提案、
                                   # 表記ゆれ・単数複数の指摘。--apply で対話的に統合実行

kura link ls <doc>                  # アウトリンク / バックリンク / 2ホップリンクを表示
kura link broken                    # 未解決リンク一覧（リンク先ドキュメントが存在しない）

kura bucket ls | add <name> [--desc] | rm <name> [--force] | mv <旧> <新>
```

### 7.5 clip（URL 取り込み）

```
kura clip <url> [--bucket b] [--tags t1,t2] [--no-llm] [--dry-run]
```

処理フロー:

1. fetch で HTML 取得（タイムアウト 30s、User-Agent 明示）
2. `@mozilla/readability` + `linkedom` で本文抽出
3. LLM で Markdown 整形（広告・ナビ残骸の除去、見出し構造の正規化、タイトル抽出）。`--no-llm` 時は turndown で機械変換
4. LLM でタグ提案（既存タグ一覧をプロンプトに含め、既存タグを優先させる）
5. `source_url` 付きで保存。同一 URL の既存ドキュメントがあれば更新確認（`--force` で上書き）
6. `--dry-run` は保存せず整形結果を表示

### 7.6 サーバー

```
kura browser [--port 7578] [--no-open]   # ブラウザ UI（§8）。起動後デフォルトブラウザを開く
kura mcp                                  # MCP サーバー（stdio、§9）
```

---

## 8. ブラウザ UI（`kura browser`）

### 8.1 アーキテクチャ

- `Bun.serve` 単一プロセス。SPA アセット（Preact + wouter）は `bun build` 成果物を `with { type: "file" }` でバイナリに埋め込み
- ポート既定 7578。EADDRINUSE 時は +1 しながら最大 10 回リトライ
- バインドは `127.0.0.1` のみ（外部公開しない）。認証なし

### 8.2 REST API

```
GET  /api/stats                          # ダッシュボード統計
GET  /api/buckets
GET  /api/docs?bucket=&tag=&sort=&stale=&page=&per=50
GET  /api/docs/:key                      # 本文 + メタ + タグ。access_count++
PUT  /api/docs/:key                      # 本文・タイトル・タグ更新（保存時に CLI と同じ再パース処理）
DELETE /api/docs/:key
GET  /api/docs/:key/related              # {outlinks, backlinks, twoHop}  ※2ホップ: 共通リンク先を持つ文書
GET  /api/search?q=&mode=keyword|vector|hybrid&bucket=&tag=
GET  /api/tags?tree=1
GET  /api/graph?bucket=&tag=             # {nodes: [{key,title,tags,degree,stale}], edges: [{source,target}]}
```

### 8.3 画面

| 画面             | 内容                                                                                                                                                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ホーム           | 最近更新 / よく参照されるドキュメント / **陳腐化候補**（§10.4）/ 統計                                                                                                                                                                                                                   |
| ドキュメント一覧 | Bucket・タグでフィルタ、ソート、ページング                                                                                                                                                                                                                                              |
| ドキュメント詳細 | **Markdown を美しくレンダリング**（GFM・シンタックスハイライト・`[[リンク]]` はクリック可能な内部リンク化・Mermaid は遅延ロード）。HTML ドキュメントは DOMPurify でサニタイズして表示。右サイドバーに**バックリンク + 2ホップリンク**（Cosense 方式）、タグ、メタ情報（参照数・更新日） |
| 編集             | プレーンテキストエディタ（textarea + 保存）。v1 はシンプルに                                                                                                                                                                                                                            |
| タグブラウザ     | 階層ツリー + 件数。クリックで絞り込み                                                                                                                                                                                                                                                   |
| ナレッジグラフ   | d3-force による force-directed グラフ。ノード=ドキュメント、エッジ=リンク。タグで色分け、陳腐化ノードは減光、クリックで詳細へ。孤立ノード（リンクなし）の表示切替                                                                                                                       |
| 検索             | 3モード切替、スニペットハイライト                                                                                                                                                                                                                                                       |

---

## 9. MCP サーバー（`kura mcp`）

`@modelcontextprotocol/sdk` の stdio トランスポート。公開ツール:

| ツール           | 引数                             | 説明                                                         |
| ---------------- | -------------------------------- | ------------------------------------------------------------ |
| `kura_query`     | `query, bucket?, tag?, limit?`   | ハイブリッド検索（リランク込み）。結果はスニペット + doc_key |
| `kura_search`    | `query, bucket?, tag?, limit?`   | 高速キーワード検索                                           |
| `kura_get`       | `key, lines?`                    | 本文取得（access_count 更新）                                |
| `kura_add`       | `title, content, bucket?, tags?` | ドキュメント追加                                             |
| `kura_update`    | `key, content?, title?, tags?`   | 更新                                                         |
| `kura_list_tags` | `prefix?`                        | タグ一覧                                                     |
| `kura_related`   | `key`                            | リンク・バックリンク・2ホップ                                |
| `kura_status`    | —                                | 統計情報                                                     |

- ツール説明文（description）にはエージェントが適切に使い分けられるよう「まず `kura_query` で検索し、`kura_get` で全文取得する」等のガイダンスを記述する
- 各ツールの結果は Markdown 文字列で返す（MCP クライアントの表示互換性のため）
- 設定例を `kura mcp --print-config` で出力（`claude mcp add` / `.mcp.json` 用スニペット）

---

## 10. 自己修復・ナレッジ健全性維持

### 10.1 未解決リンクの自動解決

ドキュメント作成・リネーム時、`links.target_id IS NULL AND target_title = <新タイトル>`（大文字小文字無視）の行を自動解決。Cosense の「先にリンクを書いておけば後からページができたとき繋がる」挙動を再現する。

### 10.2 インデックス整合性（`kura doctor --fix`）

- FTS 行数と documents 行数の不一致 → FTS リビルド
- 孤立チャンク / 孤立 vec 行 → GC
- `content_hash` と実際の本文の不一致 → 再計算 + 再チャンク
- embedding モデル変更検知 → `chunks_vec` 再作成の案内

### 10.3 タグ・ガーデニング（`kura tag audit` / `suggest`）

- 類似タグ検出: タグ名の正規化編集距離 + タグ名 embedding の cos 類似度 > 閾値で統合候補を列挙
- タグなし・タグ過少ドキュメントに LLM がタグ提案（既存タグ体系を最優先で再利用させるプロンプト設計）
- 巨大タグ（付与数が全体の 30% 超）には細分化を提案

### 10.4 陳腐化検出

陳腐化スコア = `f(最終更新からの日数, access_count, バックリンク数)`。閾値（config `stale_days`、既定 180 日）超過かつ低参照のドキュメントを `kura ls --stale`・`kura status`・ブラウザのホームに表示。削除ではなく**レビュー促進**が目的（自動削除はしない）。

---

## 11. 設定ファイル

`~/.kura/config.toml`（`kura init` が既定値で生成、`kura config` で読み書き）:

```toml
[general]
default_bucket = "main"
editor = ""                    # 空なら $EDITOR → vi
stale_days = 180

[llm]
provider = "auto"              # auto | ollama | lmstudio | none
ollama_url = "http://localhost:11434"
lmstudio_url = "http://localhost:1234"

[llm.models]
embedding = "qwen3-embedding:0.6b"
embedding_dimensions = 1024
reranker = "dengcao/Qwen3-Reranker-0.6B"
generation = "qwen3:4b"

[search]
rrf_k = 60
keyword_weight = 1.0
vector_weight = 1.0
rerank_top_k = 20
default_limit = 10

[browser]
port = 7578
```

環境変数: `KURA_HOME`（既定 `~/.kura`）、`KURA_DB`（DB パス個別上書き、テスト用）、`NO_COLOR`。

---

## 12. プロジェクト構成

```
src/
  cli/
    index.ts             # エントリポイント（shebang #!/usr/bin/env bun）、サブコマンドディスパッチ
    args.ts              # util.parseArgs ラッパー
    render.ts            # Markdown → ANSI レンダラ
    commands/            # add.ts, get.ts, search.ts, query.ts, tag.ts, link.ts, clip.ts,
                         # doctor.ts, browser.ts, mcp.ts, ...（1コマンド1ファイル）
  core/
    paths.ts             # KURA_HOME 解決
    config.ts            # TOML 読み書き
    db.ts                # setCustomSQLite、拡張ロード、マイグレーション実行
    migrations/          # 001_init.sql, ...
    bootstrap.ts         # 拡張の展開・ダウンロード（SHA256 検証）
    documents.ts         # CRUD リポジトリ（FTS/links/tags/chunks の同期を含む）
    tags.ts / links.ts / buckets.ts
    chunker.ts           # §5.2
    wiki.ts              # [[リンク]] / #タグ のパース
    search/
      keyword.ts / vector.ts / hybrid.ts / rerank.ts / expand.ts
    llm/
      provider.ts        # インターフェース + auto 検出
      ollama.ts / lmstudio.ts
      cache.ts           # llm_cache
    clip/
      extract.ts         # readability + linkedom
      format.ts          # LLM 整形 / turndown フォールバック
    doctor.ts / stale.ts / gardening.ts
  server/
    http.ts              # Bun.serve、ルーティング、SPA アセット配信
    api.ts               # REST ハンドラ
    mcp.ts               # MCP サーバー
  client/                # Preact SPA（index.tsx, pages/, components/）
scripts/
  build-html.ts          # SPA ビルド
  fetch-vendor.ts        # 開発用: sqlite-vaporetto / vec の取得
tests/
  fixtures/              # 日本語テストドキュメント一式
  *.test.ts
```

### 12.1 ビルド・配布

```json
{
  "scripts": {
    "dev": "bun run src/cli/index.ts",
    "build:client": "bun build src/client/index.tsx --outdir=dist --minify",
    "build": "bun run build:client",
    "compile": "bun run build && bun build src/cli/index.ts --compile --outfile=kura",
    "test": "bun test",
    "check": "bunx tsc --noEmit && bunx @biomejs/biome check src"
  }
}
```

- GitHub Actions（tag push トリガー）で `bun-darwin-arm64` / `bun-darwin-x64` / `bun-linux-x64` / `bun-linux-arm64` / `bun-windows-x64` をクロスコンパイルし、ZIP（`install.sh` 同梱、macOS quarantine 除去）を GitHub Release に添付（参考 gist の方式を踏襲）
- `dist/` は gitignore、CI で都度ビルド。`compile` は必ず `build` を前置
- Bun バージョンは dlopen リグレッションのない安定版に CI で固定する

---

## 13. パフォーマンス・品質目標

| 項目                                     | 目標                                                      |
| ---------------------------------------- | --------------------------------------------------------- |
| `kura search`（1万件）                   | < 100ms                                                   |
| `kura vsearch`（1万件 ≈ 3〜5万チャンク） | < 500ms                                                   |
| `kura query`（リランク込み）             | < 5s                                                      |
| `kura add` 1件（embedding 除く）         | < 200ms                                                   |
| 起動オーバーヘッド（拡張ロード込み）     | < 300ms                                                   |
| バイナリサイズ                           | < 100MB（vaporetto モデルは外部ダウンロードのため含まず） |

## 14. テスト方針

- `bun test`。DB は `KURA_DB=:memory:` またはテンポラリファイル
- **日本語検索の回帰テスト必須**: fixtures に日本語ドキュメント（技術メモ・議事録・クリップ記事の想定サンプル 30 件程度）を用意し、トークナイズ・BM25 順位・スニペットを検証
- LLM 依存テストはモックプロバイダ（`LLMProvider` 実装差し替え）で実行。実プロバイダ疎通は `kura doctor` 相当の統合テストとして CI ではスキップ可能に
- チャンカー・wiki パーサ・RRF はプロパティベースで境界値テスト
- CLI e2e: サブプロセス起動で主要フロー（init → add → search → query → export → import）を検証

## 15. 将来拡張（v1 スコープ外、設計だけ考慮）

- ブラウザ UI でのリッチエディタ（CodeMirror）
- `kura watch`: ディレクトリ監視での自動 import
- 2ホップリンクのグラフへの反映、タグページ（タグ自体に説明文を持たせる Cosense 方式）
- Homebrew tap での配布
- クエリ展開モデルのファインチューニング（qmd 方式）
