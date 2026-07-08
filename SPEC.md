# kura — Local Knowledge Management CLI Specification

## 1. Overview

`kura` is a local knowledge management CLI that stores Markdown/HTML documents in SQLite and lets both humans and AI agents query them.

- **For humans**: search, view, and edit from the CLI, plus a browser UI via `kura browser` (document viewing and knowledge-graph visualization)
- **For AI agents**: a local MCP server via `kura mcp`, and `--json` output on every command
- **Search**: hybrid RAG search with Japanese (CJK) support — FTS5 keyword search (sqlite-vaporetto) + semantic search (sqlite-vec + local embeddings) + local LLM reranking
- **Distribution**: single binary built with Bun

### 1.1 Design Principles (settled decisions)

| Item                  | Decision                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source of truth       | **SQLite**. Document bodies live in the DB; files are merely import/export I/O                                                                        |
| DB location           | **Single global DB** (`~/.kura/kura.db`). Overridable via the `KURA_HOME` environment variable                                                       |
| Expected scale        | **Up to ~10k documents**. No ANN needed; sqlite-vec's brute-force KNN is sufficient                                                                   |
| LLM provider          | **Ollama first + auto-detection**. Falls back to LM Studio if absent. Without any LLM, everything still works in degraded mode (keyword search only)  |
| Document organization | No hierarchical folders. Self-organizing via **Buckets (top-level categories) + hierarchical tags (`tech/db/sqlite`) + cross-links (`[[タイトル]]`)** (Cosense style) |
| Self-healing          | Automatic resolution of unresolved links, index consistency repair, tag gardening, and staleness detection                                            |

### 1.2 Non-Goals

- Multi-user, sync, or cloud features (local, single-user only)
- Automatic indexing via filesystem watching (ingestion is explicit: `add` / `import` / `clip` / via MCP)
- Scaling beyond 100k documents (quantization and partitioning are out of scope)
- WYSIWYG editor (editing happens in `$EDITOR` or the browser's plain editor)

---

## 2. Technology Stack

| Layer                                            | Technology                                                                | Notes                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Runtime                                          | Bun (single binary via `bun build --compile`)                             | Bun ≥ 1.3 stable. Pin the build version to avoid the canary dlopen regression (oven-sh/bun#30717)              |
| DB                                               | SQLite (WAL mode)                                                          | On macOS, point to Homebrew SQLite via `Database.setCustomSQLite()` (required, §2.1)                            |
| Keyword search                                   | FTS5 + [sqlite-vaporetto](https://github.com/hotchpotch/sqlite-vaporetto) | Japanese morphological tokenizer. Queries built with `vaporetto_or_query()` / `vaporetto_and_query()`           |
| Vector search                                    | [sqlite-vec](https://github.com/asg017/sqlite-vec)                        | The npm package officially supports Bun. `vec0` virtual table                                                   |
| embedding                                        | OpenAI-compatible `/v1/embeddings` on Ollama / LM Studio                  | Default model: `qwen3-embedding:0.6b` (1024 dimensions, multilingual)                                           |
| Rerank                                           | `/v1/chat/completions` on Ollama / LM Studio                              | Default model: `dengcao/Qwen3-Reranker-0.6B`. yes/no judgment (logprobs used for confidence when available)     |
| Generation (clip formatting, tag suggestions, query expansion) | Same chat completions                                       | Default model: `qwen3:4b` (runs comfortably on a 32GB Mac)                                                      |
| Browser UI                                       | Bun.serve + Preact SPA (embedded in the binary)                            | markdown-it + highlight.js + DOMPurify; graph via d3-force                                                      |
| MCP                                              | `@modelcontextprotocol/sdk` (stdio)                                        |                                                                                                                 |
| CLI argument parsing                             | Node.js native `util.parseArgs`                                            | No commander or similar (keeps the binary small)                                                                |

### 2.1 SQLite Extension Loading Strategy (important)

Native extensions (.dylib/.so/.dll) cannot be embedded directly into a single binary and dlopen'd, so the strategy is:

1. **sqlite-vec**: embedded into the binary with `with { type: "file" }`, extracted to `~/.kura/lib/<kura version>/` on first launch, then loaded with `loadExtension()`. Uses prebuilt npm packages such as `sqlite-vec-darwin-arm64`
2. **sqlite-vaporetto**: the extension + morphological model (`bccwj-suw+unidic_pos+kana.model.zst`, large) are not embedded; they are **downloaded from GitHub Releases into `~/.kura/lib/<version>/` on first launch (or via `kura doctor --fix`)**. SHA256 verification is mandatory
3. **macOS**: always call `Database.setCustomSQLite()` before creating the first `Database`. Resolve the path via `process.arch`:
   - arm64: `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`
   - x64: `/usr/local/opt/sqlite/lib/libsqlite3.dylib`
   - If missing, `kura doctor` suggests `brew install sqlite`

**Degraded mode (part of self-healing)**: in environments where vaporetto cannot be loaded (e.g. macOS x64, where no binary is published), automatically fall back to FTS5's `trigram` tokenizer. The tokenizer in use is recorded in the `meta` table; if the environment changes, `doctor` suggests reindexing.

### 2.2 Supported Platforms

| Target                  | vaporetto                | Notes                                                |
| ----------------------- | ------------------------ | ---------------------------------------------------- |
| darwin-arm64            | ✅                       | First-class support (development and primary usage environment) |
| linux-x64 / linux-arm64 | ✅                       |                                                      |
| darwin-x64              | ❌ → trigram fallback    | No vaporetto binary is published                     |
| windows-x64             | ✅                       | Best effort                                          |

---

## 3. Data Model

### 3.1 Schema (migration v1)

The schema version is tracked via `PRAGMA user_version`; missing migrations are applied automatically at startup.

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Bucket: top-level knowledge category (e.g. internal / external / personal)
CREATE TABLE buckets (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,          -- lowercase alphanumerics and - only
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO buckets (name, description) VALUES ('main', 'Default bucket');

CREATE TABLE documents (
  id               INTEGER PRIMARY KEY,
  doc_key          TEXT NOT NULL UNIQUE,     -- 8-char short ID (hash of content + randomness; equivalent to qmd's docid)
  bucket_id        INTEGER NOT NULL REFERENCES buckets(id),
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  content_type     TEXT NOT NULL DEFAULT 'markdown',  -- 'markdown' | 'html'
  source_url       TEXT,                     -- e.g. the URL a clip came from
  content_hash     TEXT NOT NULL,            -- sha256; used for change detection and re-embedding decisions
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,                     -- updated by get / MCP get / fetching a search result body
  access_count     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (bucket_id, title)                  -- titles are unique within a bucket (for resolving [[リンク]])
);
CREATE INDEX idx_documents_bucket ON documents(bucket_id);
CREATE INDEX idx_documents_updated ON documents(updated_at);

-- Tags: hierarchical via slash separators ('tech/db/sqlite'). The tag entity table itself
CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE                  -- normalized: lowercased, leading/trailing slashes stripped, consecutive slashes collapsed
);

CREATE TABLE document_tags (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'manual', -- 'manual' | 'auto' (assigned by LLM)
  PRIMARY KEY (document_id, tag_id)
);

-- Cross-links: [[タイトル]] occurrences in the body, extracted and synced on save
CREATE TABLE links (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_id    INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  target_title TEXT NOT NULL,                -- raw text inside [[...]]; NULL target_id means an unresolved link
  UNIQUE (source_id, target_title)
);
CREATE INDEX idx_links_target ON links(target_id);
CREATE INDEX idx_links_unresolved ON links(target_title) WHERE target_id IS NULL;

-- Chunks: the unit of embedding (§5.2)
CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  start_offset INTEGER NOT NULL,             -- start position within the body (for line-number jumps)
  embedded_at  TEXT,                         -- NULL = embedding not yet generated (backfill target)
  UNIQUE (document_id, seq)
);

-- FTS5: standard table (not contentless, so highlight/snippet work; storage is acceptable at ~10k docs)
-- tokenize is decided at setup time as vaporetto / trigram and built accordingly (§2.1)
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, content, tags,
  tokenize='vaporetto model {KURA_HOME}/lib/{ver}/bccwj-suw+unidic_pos+kana.model.zst'
);
-- Sync is done by the repository layer within the same transaction, not by triggers (the tags column is synthesized)

-- sqlite-vec: chunk embeddings (dimensions come from config; default 1024)
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,              -- corresponds to chunks.id
  embedding float[1024]
);

-- LLM response cache (query expansion, rerank scores, tag suggestions)
CREATE TABLE llm_cache (
  cache_key  TEXT PRIMARY KEY,               -- sha256(purpose + model + input)
  purpose    TEXT NOT NULL,                  -- 'expand' | 'rerank' | 'tag' | 'clip'
  value      TEXT NOT NULL,                  -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- System metadata
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,                    -- 'embedding_model', 'embedding_dimensions',
  value TEXT NOT NULL                        -- 'fts_tokenizer', 'schema_version', etc.
);
```

### 3.2 Consistency Rules

- Creating, updating, or deleting a row in `documents` must sync `documents_fts` / `links` / `document_tags` / `chunks` within a single transaction
- On body update: only when `content_hash` changed, re-chunk + delete the matching `chunks_vec` rows + set `embedded_at = NULL` (embeddings are lazily backfilled, §5.3)
- On title change or new document creation: automatically resolve unresolved links whose `links.target_title` matches, and rewire links pointing at the old title (see `kura mv`)
- When a change of embedding model or dimensions is detected (`meta` and config disagree), recreate `chunks_vec` and prompt a full re-embedding (`doctor` detects it; run via `kura embed --all`)

---

## 4. Document Syntax

- Bodies are Markdown (GFM). Raw HTML can also be stored with `content_type = 'html'`
- **Wiki links**: `[[タイトル]]` or `[[タイトル|表示テキスト]]` (title, or title with display text). Extracted into `links` on save. Matched case-insensitively against titles within the bucket
- **Hashtags**: `#tech/db/sqlite`-style tags in the body are extracted on save as `document_tags(source='manual')` (merged with frontmatter tags)
- **frontmatter** (used for round-tripping on import/export):

```markdown
---
kura_key: a1b2c3d4 # assigned on export; if present on import, treated as an update
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

## 5. Search Pipeline

Following qmd's architecture, three tiers of search modes are provided.

### 5.1 Search Modes

| Command        | Method                  | Latency target                  | LLM requirement      |
| -------------- | ----------------------- | ------------------------------- | -------------------- |
| `kura search`  | FTS5 BM25 only          | < 100ms                         | none                 |
| `kura vsearch` | Vector KNN only         | < 500ms (incl. query embedding) | embedding            |
| `kura query`   | Hybrid + rerank         | < 5s                            | embedding + reranker |

The `kura query` pipeline:

```
Query
  ├─ (optional --expand) LLM query expansion: original query (weight 2) + 2 variants. Cached in llm_cache
  ├─ FTS5: WHERE documents_fts MATCH vaporetto_or_query(?) → top 50 by bm25()
  └─ vec:  query embedding → chunks_vec KNN top 50 → aggregated per document by max score
  ↓
RRF fusion (k=60; weights from config keyword_weight / vector_weight)
  ↓ top 20 (rerank_top_k)
Rerank: yes/no judgment of each candidate chunk via chat completions (parallel, uses llm_cache)
  ↓
Final score = position-weighted blend (qmd style):
  RRF rank 1–3:  RRF 75% + rerank 25%
  RRF rank 4–10: RRF 60% + rerank 40%
  RRF rank 11+:  RRF 40% + rerank 60%
```

**Degraded mode**: if the embedding provider is unreachable, `query` runs FTS only and prints a warning. If the reranker is absent, the RRF results are returned as-is. Never fail with an error.

### 5.2 Chunking (simplified qmd approach)

- Target chunk size: **1600 characters** (日本語 ≈ 900〜1000 tokens), 15% overlap
- Breakpoint priorities: H1(100) > H2(90) > H3(80) > code block boundary (80; never split inside a block) > horizontal rule (60) > blank line (20) > end of line (1)
- Score decay by distance from the target size: `finalScore = baseScore × (1 - (distance/400)² × 0.7)`
- A context header `# {title} > {nearest heading}` is prepended to each chunk before embedding (improves retrieval accuracy)

### 5.3 Lazy Embedding Backfill

`add` / `edit` / `clip` do **not block** on embedding generation (they only save with `embedded_at = NULL`). Embeddings are generated:

1. On an explicit `kura embed`
2. When `vsearch` / `query` runs and un-embedded chunks exist, they are backfilled automatically before searching (if there are many, print a warning, run the search anyway, and point to `kura embed`)
3. As idle background work while the `kura browser` / `kura mcp` server is running

### 5.4 FTS Query Conventions

- With vaporetto: turn user input into an OR query via `vaporetto_or_query()` and rank with BM25 (AND with `search --all`). Weight title / content / tags via `bm25(documents_fts, 5.0, 1.0, 3.0)`
- With the trigram fallback: escape the input into a `"..."` phrase plus whitespace-separated OR terms
- Snippets are generated with `snippet(documents_fts, 1, '**', '**', '…', 20)`

---

## 6. LLM Provider Abstraction

```typescript
interface LLMProvider {
  name: "ollama" | "lmstudio";
  isAvailable(): Promise<boolean>; // Ollama: GET /api/tags, LM Studio: GET /v1/models
  hasModel(model: string): Promise<boolean>;
  embed(
    texts: string[],
    model: string,
    dimensions?: number,
  ): Promise<Float32Array[]>; // POST /v1/embeddings (batched)
  chat(
    messages: Message[],
    model: string,
    opts?: { temperature?: number },
  ): Promise<string>; // POST /v1/chat/completions
}
```

- Resolution order (`provider = "auto"`): Ollama (`http://localhost:11434`) → LM Studio (`http://localhost:1234`) → none
- Detection results are cached in-process (TTL 60 seconds). With `none`, LLM-dependent features return a clear error message and point the user to `kura doctor`
- Default models:
  - embedding: `qwen3-embedding:0.6b` (1024 dimensions. `kun432/cl-nagoya-ruri-large` can be configured as a Japanese-accuracy-focused alternative; the dimension count follows in config)
  - reranker: `dengcao/Qwen3-Reranker-0.6B`
  - generation: `qwen3:4b`
- All can be loaded simultaneously on a 32GB Mac (total < 4GB)

---

## 7. CLI Command Specification

Global conventions:

- Every read command supports `--json` for machine-readable output (for agent integration)
- Document specifier `<doc>`: a `doc_key` (8 chars), a key with a `#` prefix, or a title unique within the bucket
- `--bucket <name>`: target bucket (defaults to config `default_bucket`; search commands default to all buckets when omitted)
- Exit codes: 0=success, 1=general error, 2=argument error, 3=not found, 4=LLM provider unavailable
- On a TTY, Markdown is rendered as ANSI (headings, emphasis, code blocks, lists; a lightweight in-house renderer). Raw text when piped

### 7.1 Setup and Diagnostics

```
kura init                     # initialize ~/.kura/, extract/download extensions, create the DB, generate config
kura doctor [--fix]           # diagnostics: Homebrew SQLite / extension loading / vaporetto model / Ollama & LM Studio reachability
                             #       presence of required models (suggests `ollama pull ...` if missing) / DB integrity
                             #       FTS & vec index consistency / embedding model change detection
                             # --fix: re-fetch extensions, rebuild FTS, GC orphaned chunks, re-resolve unresolved links
kura status [--json]          # stats: doc counts per bucket, tag count, embedding coverage, stale doc count, DB size
kura config [get|set|list]    # read/write settings (~/.kura/config.toml)
```

### 7.2 Document CRUD

```
kura add <file>... [--bucket b] [--tags t1,t2] [--title T] [--type markdown|html]
kura add -                    # from stdin; --title required
kura get <doc> [--pretty|--raw] [--json] [--lines 50:100]
                             # increments access_count / updates last_accessed_at
kura edit <doc>               # write the body to a temp file, edit in $EDITOR, re-parse on save
kura rm <doc> [--force]
kura mv <doc> <new-title>     # rename; existing [[旧タイトル]] links are rewired automatically
kura ls [--bucket b] [--tag t] [--sort updated|created|accessed|title] [--stale] [--limit n]
kura export [--bucket b] [--tag t] --dir <path>   # write out as Markdown with frontmatter (doubles as a backup)
kura import <dir|file>... [--bucket b]            # update if frontmatter has kura_key, otherwise create
```

### 7.3 Search

```
kura search  "query" [--bucket b] [--tag t] [--all] [--limit 20] [--json]
kura vsearch "query" [--bucket b] [--tag t] [--limit 20] [--json]
kura query   "query" [--bucket b] [--tag t] [--expand] [--limit 10] [--json]
kura embed   [--all]          # generate embeddings for pending chunks (--all forces regeneration of everything)
```

Search result display: `doc_key, title, bucket, tags, score, snippet (matches highlighted)`. With `--json`, an array of `{key, title, bucket, tags, score, snippet, source}`.

### 7.4 Tags, Links, and Buckets

```
kura tag ls [--tree]                # list tags (--tree shows the hierarchy + counts)
kura tag add <doc> <tag>...
kura tag rm <doc> <tag>...
kura tag mv <old-path> <new-path>   # rename/consolidate (descendant tags move together); merges if the target exists
kura tag suggest [--doc d] [--untagged] [--apply]
                                   # LLM suggests tags. Without --apply, suggestions are shown only (applied after interactive confirmation)
kura tag gc                         # delete tags not attached to any document
kura tag audit [--apply]            # gardening: detect similar tags (edit distance + embedding similarity) and propose merges,
                                   # flag spelling variants and singular/plural issues. --apply merges interactively

kura link ls <doc>                  # show outlinks / backlinks / 2-hop links
kura link broken                    # list unresolved links (the target document does not exist)

kura bucket ls | add <name> [--desc] | rm <name> [--force] | mv <old> <new>
```

### 7.5 clip (URL ingestion)

```
kura clip <url> [--bucket b] [--tags t1,t2] [--no-llm] [--dry-run]
```

Processing flow:

1. Fetch the HTML (30s timeout, explicit User-Agent)
2. Extract the main content with `@mozilla/readability` + `linkedom`
3. Format into Markdown with the LLM (strip leftover ads/navigation, normalize heading structure, extract the title). With `--no-llm`, convert mechanically with turndown
4. LLM tag suggestions (the existing tag list is included in the prompt so existing tags are preferred)
5. Save with `source_url`. If a document with the same URL already exists, confirm before updating (`--force` overwrites)
6. `--dry-run` shows the formatted result without saving

### 7.6 Servers

```
kura browser [--port 7578] [--no-open]   # browser UI (§8); opens the default browser after startup
kura mcp                                  # MCP server (stdio, §9)
```

---

## 8. Browser UI (`kura browser`)

### 8.1 Architecture

- Single `Bun.serve` process. SPA assets (Preact + wouter) are `bun build` artifacts embedded into the binary with `with { type: "file" }`
- Default port 7578. On EADDRINUSE, increment by 1 and retry up to 10 times
- Binds to `127.0.0.1` only (never exposed externally). No authentication

### 8.2 REST API

```
GET  /api/stats                          # dashboard statistics
GET  /api/buckets
GET  /api/docs?bucket=&tag=&sort=&stale=&page=&per=50
GET  /api/docs/:key                      # body + metadata + tags; increments access_count
PUT  /api/docs/:key                      # update body/title/tags (same re-parsing on save as the CLI)
DELETE /api/docs/:key
GET  /api/docs/:key/related              # {outlinks, backlinks, twoHop}  * 2-hop: documents sharing a common link target
GET  /api/search?q=&mode=keyword|vector|hybrid&bucket=&tag=
GET  /api/tags?tree=1
GET  /api/graph?bucket=&tag=             # {nodes: [{key,title,tags,degree,stale}], edges: [{source,target}]}
```

### 8.3 Screens

| Screen          | Content                                                                                                                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Home            | Recently updated / most-referenced documents / **staleness candidates** (§10.4) / statistics                                                                                                                                                                                                |
| Document list   | Filter by bucket and tag, sorting, paging                                                                                                                                                                                                                                                    |
| Document detail | **Beautifully rendered Markdown** (GFM, syntax highlighting, `[[リンク]]` turned into clickable internal links, Mermaid lazy-loaded). HTML documents are sanitized with DOMPurify before display. Right sidebar shows **backlinks + 2-hop links** (Cosense style), tags, and metadata (reference count, updated date) |
| Editor          | Plain-text editor (textarea + save). Kept simple in v1                                                                                                                                                                                                                                       |
| Tag browser     | Hierarchical tree + counts. Click to filter                                                                                                                                                                                                                                                  |
| Knowledge graph | Force-directed graph via d3-force. Nodes = documents, edges = links. Colored by tag, stale nodes dimmed, click to open the detail view. Toggle for showing isolated nodes (no links)                                                                                                         |
| Search          | 3-mode toggle, snippet highlighting                                                                                                                                                                                                                                                          |

---

## 9. MCP Server (`kura mcp`)

Uses the stdio transport of `@modelcontextprotocol/sdk`. Exposed tools:

| Tool             | Arguments                        | Description                                                    |
| ---------------- | -------------------------------- | -------------------------------------------------------------- |
| `kura_query`     | `query, bucket?, tag?, limit?`   | Hybrid search (rerank included). Results are snippets + doc_key |
| `kura_search`    | `query, bucket?, tag?, limit?`   | Fast keyword search                                             |
| `kura_get`       | `key, lines?`                    | Fetch the body (updates access_count)                           |
| `kura_add`       | `title, content, bucket?, tags?` | Add a document                                                  |
| `kura_update`    | `key, content?, title?, tags?`   | Update                                                          |
| `kura_list_tags` | `prefix?`                        | List tags                                                       |
| `kura_related`   | `key`                            | Links, backlinks, 2-hop                                         |
| `kura_status`    | —                                | Statistics                                                      |

- Tool descriptions include guidance so agents pick the right tool, e.g. "search with `kura_query` first, then fetch the full text with `kura_get`"
- Every tool returns its result as a Markdown string (for MCP client display compatibility)
- `kura mcp --print-config` prints configuration examples (snippets for `claude mcp add` / `.mcp.json`)

---

## 10. Self-Healing and Knowledge Health Maintenance

### 10.1 Automatic Resolution of Unresolved Links

On document creation or rename, automatically resolve rows matching `links.target_id IS NULL AND target_title = <new title>` (case-insensitive). This reproduces Cosense's behavior of "write the link first, and it connects once the page is created later."

### 10.2 Index Consistency (`kura doctor --fix`)

- FTS row count differs from the documents row count → rebuild FTS
- Orphaned chunks / orphaned vec rows → GC
- `content_hash` doesn't match the actual body → recompute + re-chunk
- Embedding model change detected → suggest recreating `chunks_vec`

### 10.3 Tag Gardening (`kura tag audit` / `suggest`)

- Similar-tag detection: enumerate merge candidates using normalized edit distance of tag names + cosine similarity of tag-name embeddings above a threshold
- The LLM suggests tags for untagged or under-tagged documents (prompt designed to strongly prefer reusing the existing tag taxonomy)
- Suggest splitting oversized tags (attached to more than 30% of all documents)

### 10.4 Staleness Detection

Staleness score = `f(days since last update, access_count, backlink count)`. Documents exceeding the threshold (config `stale_days`, default 180 days) with low reference counts are surfaced in `kura ls --stale`, `kura status`, and the browser home screen. The goal is to **prompt review**, not deletion (nothing is ever deleted automatically).

---

## 11. Configuration File

`~/.kura/config.toml` (generated with defaults by `kura init`, read/written via `kura config`):

```toml
[general]
default_bucket = "main"
editor = ""                    # empty means $EDITOR → vi
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

Environment variables: `KURA_HOME` (default `~/.kura`), `KURA_DB` (overrides just the DB path; for tests), `NO_COLOR`.

---

## 12. Project Layout

```
src/
  cli/
    index.ts             # entry point (shebang #!/usr/bin/env bun), subcommand dispatch
    args.ts              # util.parseArgs wrapper
    render.ts            # Markdown → ANSI renderer
    commands/            # add.ts, get.ts, search.ts, query.ts, tag.ts, link.ts, clip.ts,
                         # doctor.ts, browser.ts, mcp.ts, ... (one file per command)
  core/
    paths.ts             # KURA_HOME resolution
    config.ts            # TOML read/write
    db.ts                # setCustomSQLite, extension loading, migration runner
    migrations/          # 001_init.sql, ...
    bootstrap.ts         # extension extraction/download (SHA256 verification)
    documents.ts         # CRUD repository (including FTS/links/tags/chunks sync)
    tags.ts / links.ts / buckets.ts
    chunker.ts           # §5.2
    wiki.ts              # parsing of [[リンク]] / #タグ
    search/
      keyword.ts / vector.ts / hybrid.ts / rerank.ts / expand.ts
    llm/
      provider.ts        # interface + auto detection
      ollama.ts / lmstudio.ts
      cache.ts           # llm_cache
    clip/
      extract.ts         # readability + linkedom
      format.ts          # LLM formatting / turndown fallback
    doctor.ts / stale.ts / gardening.ts
  server/
    http.ts              # Bun.serve, routing, SPA asset serving
    api.ts               # REST handlers
    mcp.ts               # MCP server
  client/                # Preact SPA (index.tsx, pages/, components/)
scripts/
  build-html.ts          # SPA build
  fetch-vendor.ts        # dev helper: fetch sqlite-vaporetto / vec
tests/
  fixtures/              # a set of Japanese test documents
  *.test.ts
```

### 12.1 Build and Distribution

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

- GitHub Actions (triggered on tag push) cross-compiles `bun-darwin-arm64` / `bun-darwin-x64` / `bun-linux-x64` / `bun-linux-arm64` / `bun-windows-x64` and attaches ZIPs (bundling `install.sh`, with macOS quarantine removal) to the GitHub Release (following the approach of the referenced gist)
- `dist/` is gitignored and rebuilt in CI every time. `compile` must always be preceded by `build`
- Pin the Bun version in CI to a stable release free of the dlopen regression

---

## 13. Performance and Quality Targets

| Item                                        | Target                                                        |
| ------------------------------------------- | ------------------------------------------------------------- |
| `kura search` (10k docs)                    | < 100ms                                                       |
| `kura vsearch` (10k docs ≈ 30k–50k chunks)  | < 500ms                                                       |
| `kura query` (incl. rerank)                 | < 5s                                                          |
| `kura add`, one document (excl. embedding)  | < 200ms                                                       |
| Startup overhead (incl. extension loading)  | < 300ms                                                       |
| Binary size                                 | < 100MB (excludes the vaporetto model, which is downloaded separately) |

## 14. Testing Policy

- `bun test`. The DB is `KURA_DB=:memory:` or a temporary file
- **Japanese-search regression tests are mandatory**: prepare Japanese documents in fixtures (about 30 samples resembling tech notes, meeting minutes, and clipped articles) and verify tokenization, BM25 ranking, and snippets
- LLM-dependent tests run against a mock provider (swapping the `LLMProvider` implementation). Real-provider connectivity is an integration test equivalent to `kura doctor` and can be skipped in CI
- Property-based boundary tests for the chunker, the wiki parser, and RRF
- CLI e2e: spawn subprocesses to verify the main flow (init → add → search → query → export → import)

## 15. Future Extensions (out of v1 scope; design only accounts for them)

- Rich editor in the browser UI (CodeMirror)
- `kura watch`: automatic import via directory watching
- Reflecting 2-hop links in the graph; tag pages (Cosense style, giving tags their own description text)
- Distribution via a Homebrew tap
- Fine-tuning the query-expansion model (qmd style)
