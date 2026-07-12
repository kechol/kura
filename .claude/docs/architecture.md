# Architecture

> Covers SPEC §1, §12. Key sources: `src/cli/index.ts`, `src/core/db.ts`, `src/core/documents.ts`, `src/core/search/hybrid.ts`, `scripts/compile.ts`

kura is a local knowledge management CLI: Markdown/HTML documents live in a
single SQLite database and are served to humans (CLI, browser UI) and AI
agents (MCP server, `--json` on every read command). Japanese-aware hybrid
search is the core feature. Distribution is a single Bun binary.

## Design principles (settled decisions)

| Item | Decision |
| --- | --- |
| Source of truth | **SQLite**. Document bodies live in the DB; files are import/export I/O only |
| DB location | **Single global DB** at `~/.kura/kura.db` (`KURA_HOME` / `KURA_DB` override, `src/core/paths.ts`) |
| Expected scale | **~10k documents**. No ANN index; sqlite-vec brute-force KNN is sufficient |
| LLM provider | **Ollama first, auto-detected**, LM Studio fallback. Everything still works without any LLM (degraded mode) |
| Organization | No folders. Self-organizing via **Buckets** (top-level categories) + **hierarchical tags** (`tech/db/sqlite`) + **cross-links** (`[[タイトル]]`) |
| Self-healing | Automatic unresolved-link resolution, index consistency repair (`kura doctor --fix`), tag gardening, staleness detection |

### Non-goals

- Multi-user, sync, or cloud features (local, single-user only)
- Filesystem watching (ingestion is explicit: `add` / `import` / `clip` / MCP)
- Scaling beyond 100k documents (no quantization/partitioning)
- WYSIWYG editing (`$EDITOR` or the browser's plain textarea)

## Layers and dependency direction

```
src/core   ← src/cli      (one file per command; maps errors to exit codes)
           ← src/server   (REST + MCP; handlers must reuse core, no logic duplication)
src/client — talks to src/server over HTTP only (never imports core)
src/generated — build artifacts consumed by core/server (dev stub in git)
```

`src/core` has no dependency on cli/server/client. Anything that touches the
database goes through core; the CLI and both servers are thin adapters.

### Module map

| Module | Role |
| --- | --- |
| `src/cli/index.ts` | Entry point; lazy-imported subcommand registry; error-class → exit-code mapping |
| `src/cli/args.ts` | `util.parseArgs` wrapper, `EXIT` constants, shared option helpers |
| `src/cli/render.ts` | Markdown → ANSI renderer for TTY output (raw text when piped) |
| `src/cli/searchOutput.ts` | Shared search-result printing (`--json` / human table) |
| `src/cli/commands/*.ts` | One file per subcommand exporting `summary` / `usage` / `run` |
| `src/core/paths.ts` | `KURA_HOME` / `KURA_DB` / lib-dir / config-path resolution, version constant |
| `src/core/config.ts` | `config.toml` defaults, load/merge/save |
| `src/core/db.ts` | `setCustomSQLite`, extension loading, migration runner, `meta` accessors, connection singleton |
| `src/core/migrations/001_init.sql` | Schema v1 DDL with runtime placeholders (see [data-model.md](data-model.md)) |
| `src/core/bootstrap.ts` | sqlite-vec extraction from the binary; SHA256-pinned sqlite-vaporetto download |
| `src/core/errors.ts` | Error classes carrying the exit-code convention |
| `src/core/documents.ts` | Document repository: CRUD + single-transaction sync of all derived data |
| `src/core/buckets.ts` | Bucket CRUD and name validation |
| `src/core/tags.ts` | Tag normalization, doc-tag assignment, rename/merge, GC, tree building |
| `src/core/links.ts` | Link sync, unresolved-link resolution, outlinks/backlinks/2-hop, broken links |
| `src/core/fts.ts` | `documents_fts` upsert/delete/tags-refresh helpers (no SQL triggers) |
| `src/core/frontmatter.ts` | YAML frontmatter parse/serialize, timestamp conversion (see [document-notation.md](document-notation.md)) |
| `src/core/wiki.ts` | `[[link]]` / `#tag` extraction, code-block masking, rename rewriting |
| `src/core/chunker.ts` | Markdown-aware chunk splitting for embeddings (context header per chunk) |
| `src/core/search/` | `keyword.ts` (FTS5 BM25), `vector.ts` (KNN + backfill), `hybrid.ts` (RRF + blend), `rerank.ts`, `expand.ts`, `types.ts` |
| `src/core/llm/` | `provider.ts` (interface + auto-detection), `ollama.ts`, `lmstudio.ts`, `cache.ts` (`llm_cache`) |
| `src/core/clip/` | `extract.ts` (readability + linkedom), `format.ts` (LLM formatting / turndown fallback) |
| `src/core/doctor.ts` | Self-healing fixes: FTS rebuild/retokenize, orphan GC, hash repair, link resolution, vec recreation |
| `src/core/stale.ts` / `gardening.ts` / `stats.ts` | Staleness scoring, tag audit, `kura status` statistics |
| `src/server/http.ts` | `Bun.serve` wiring, port retry, SPA asset serving (127.0.0.1 only) |
| `src/server/api.ts` | REST handlers |
| `src/server/mcp.ts` | MCP stdio server tools |
| `src/client/` | Preact SPA (intentionally Japanese UI strings, see `CLAUDE.md`) |
| `src/generated/embedded.ts` | Embedded-asset table. A stub in dev (assets resolve from `dist/` / `node_modules`); `scripts/compile.ts` overwrites it for the binary and restores the stub afterwards |
| `scripts/` | `build-html.ts` (SPA build), `compile.ts` (single binary), `fetch-vendor.ts` (prebuilt extension fetch), `package-release.ts`, installers |

## Cross-cutting invariants

### Derived data is synced in one transaction — no triggers

Every create/update/delete of a `documents` row must keep `documents_fts`,
`links`, `document_tags`, and `chunks` consistent **inside a single
transaction in the repository layer** (`syncDerived` in
`src/core/documents.ts`). There are **no SQL triggers**, because the FTS
`tags` column is synthesized at write time and `chunks_vec` (vec0) is not
covered by foreign keys. Consequently: **never UPDATE/DELETE `documents`
directly** — always go through the repository functions. Tag-only operations
refresh FTS via `ftsRefreshTags` (`src/core/fts.ts`).

### macOS: `setCustomSQLite` before the first `Database`

Apple's bundled SQLite cannot load extensions. On macOS,
`Database.setCustomSQLite(<Homebrew libsqlite3.dylib>)` must run **before the
first `Database` instance is created**, otherwise `loadExtension()` crashes
the process with SIGSEGV. `setupSqlite()` in `src/core/db.ts` enforces this;
**always open connections through `openDatabase()` / `getDb()`**, never with
`new Database(...)` directly.

### Degraded operation

Every LLM-dependent feature must keep working (with a printed warning) when
no provider is reachable: `kura query` degrades to keyword-only, rerank
failures fall back to RRF order, missing vaporetto falls back to the FTS5
`trigram` tokenizer (with a LIKE fallback for <3-char terms,
`src/core/search/keyword.ts`). Search commands never fail hard because an
LLM is missing; only explicitly LLM-only operations (e.g. `kura embed`)
raise `LLMUnavailableError`.

### Exit codes

Defined in `src/cli/args.ts` and mapped from error classes
(`src/core/errors.ts`) in `src/cli/index.ts`:

| Code | Meaning | Error class |
| --- | --- | --- |
| 0 | success | — |
| 1 | general error (includes conflicts) | `ConflictError`, anything unclassified |
| 2 | usage / argument error | `UsageError` |
| 3 | not found | `NotFoundError` |
| 4 | LLM provider unavailable | `LLMUnavailableError` |

## Data flow: saving a document

All ingestion paths (`kura add` / `edit` / `import` / `clip`, `PUT
/api/docs/:key`, MCP `kura_add` / `kura_update`) converge on
`createDocument` / `updateDocument` in `src/core/documents.ts`:

```
caller (cli / server / mcp)
  └─ createDocument / updateDocument          BEGIN TRANSACTION
       ├─ validate bucket; full-path uniqueness (case-insensitive, per bucket)
       ├─ INSERT / UPDATE documents  (content_hash = sha256(content))
       ├─ syncDerived:
       │    ├─ extractWiki(content)              [skipped for content_type='html']
       │    ├─ addTagsToDoc: tags + document_tags + FTS tags column
       │    ├─ syncLinks: DELETE + re-INSERT links rows, resolving each
       │    │             target two-stage (full path, then unique title)
       │    ├─ ftsUpsert: DELETE + INSERT documents_fts (rowid = documents.id)
       │    ├─ rebuildChunks          [only when content or title changed]:
       │    │     delete chunks_vec rows → delete chunks → insert new chunks
       │    │     with embedded_at = NULL (embedding deferred, SPEC §5.3)
       │    └─ resolveUnresolvedLinks [on create / rename / move]: earlier
       │          [[links]] to this title or full path connect automatically
       └─ COMMIT
```

Embeddings are **not** generated here — `kura embed` or the pre-search
backfill picks up `embedded_at IS NULL` chunks later.

## Data flow: `kura query`

`src/cli/commands/query.ts` → `hybridQuery` in `src/core/search/hybrid.ts`:

```
query string
  ├─ resolveProvider (Ollama → LM Studio → none; result cached 60s in-process)
  ├─ [--expand, provider present] expandQuery via LLM (llm_cache):
  │     variants = original (weight 2) + expansions (weight 1)
  ├─ per variant: keywordSearch  — documents_fts MATCH, bm25(5.0, 1.0, 3.0), top 50
  ├─ [provider] ensureEmbeddings — auto-backfill ≤100 pending chunks, else warn
  ├─ [provider] per variant: vectorSearchDetailed
  │     embed query → chunks_vec KNN → best chunk per document, top 50
  ├─ RRF fusion  (k = rrf_k, contribution = list_weight × variant_weight / (k + rank))
  ├─ top rerank_top_k → [provider] rerankCandidates (yes/no chat judgment, llm_cache)
  ├─ blendScores — position-weighted RRF/rerank mix:
  │     RRF rank 1–3: 75/25   rank 4–10: 60/40   rank 11+: 40/60
  └─ hits (top limit) + warnings
       degraded: no provider → keyword-only; vector or rerank failure → warn and continue
```

## Deviations from SPEC

- **Module layout (§12)**: the implementation adds files the SPEC tree does
  not list — `src/core/fts.ts`, `src/core/frontmatter.ts`,
  `src/core/errors.ts`, `src/core/stats.ts`, `src/core/search/types.ts`,
  `src/cli/searchOutput.ts`, `src/generated/embedded.ts`, and
  `scripts/compile.ts` / `scripts/package-release.ts` / installers. The rest
  of the SPEC tree matches.
- **Compile pipeline (§12.1)**: `bun run compile` executes
  `scripts/compile.ts` (which regenerates `src/generated/embedded.ts`,
  embeds SPA assets and the sqlite-vec library, runs `bun build --compile`,
  then restores the dev stub) instead of the SPEC's inline package.json
  one-liner.
- **Idle backfill (§5.3 item 3)**: SPEC promises background embedding while
  `kura browser` / `kura mcp` run; this is not implemented. Backfill happens
  only via explicit `kura embed` or the pre-search `ensureEmbeddings`
  auto-backfill (≤100 pending chunks).
