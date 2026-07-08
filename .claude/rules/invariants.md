---
description: Non-negotiable code and data invariants — repository-layer writes, no SQL triggers, macOS SQLite setup order, forward-only migrations, degraded operation, stable JSON / exit-code contracts. Violating these silently corrupts the SQLite store or breaks the agent-facing contract.
paths:
  - "src/**/*.ts"
---

# Invariants

The authoritative descriptions behind these rules live in
`.claude/docs/` (data-model.md, native-extensions.md, search-pipeline.md,
cli-reference.md). This file is the short list of things you may **not**
change without the accompanying migration / doc / CHANGELOG work.

## R1. Never write `documents` (or derived tables) directly

The repository layer in `src/core/documents.ts` is the only writer of
`documents`, `documents_fts`, `links`, `document_tags`, and `chunks`.
**There are no SQL triggers** — the sync is done in TypeScript. A raw
`UPDATE documents SET ...` or an ad-hoc `INSERT INTO documents_fts`
outside the repository leaves the FTS index, link graph, tag rows, and
chunk table inconsistent with `documents`, and nothing repairs it until
`kura doctor --fix` rebuilds from scratch.

Add new mutations as repository functions. Reads may query directly;
writes may not.

## R2. Derived-table sync happens inside one transaction

A single logical document change (create / update / rename / delete)
updates `documents` **and** every derived table
(`documents_fts` / `links` / `document_tags` / `chunks`) inside one
`BEGIN … COMMIT`. A half-applied write is the failure mode this prevents:
a crash mid-update must roll the whole thing back, never leave the FTS row
pointing at stale text.

## R3. macOS SQLite is configured before the first `Database`

`setupSqlite()` calls `Database.setCustomSQLite(<Homebrew libsqlite3>)`
and **must run before any `Database` is constructed** — Apple's bundled
SQLite cannot `loadExtension`, and once a connection exists the custom
SQLite can no longer be swapped in (extension loading then crashes the
process). Always open connections through `openDatabase()` / `getDb()` in
`src/core/db.ts`; never `new Database(...)` elsewhere. `setupSqlite()` is
idempotent and a no-op off macOS.

## R4. Degraded operation is mandatory, per dependency

- **sqlite-vec is required.** It backs `chunks_vec`; failing to load it
  is a hard error with a `kura doctor` hint (`openDatabase` throws).
- **Everything else degrades with a warning, never a crash:**
  - sqlite-vaporetto missing / failing to load → fall back to the
    `trigram` FTS tokenizer (recorded in `meta`, see R5).
  - No reachable LLM provider → keyword search still works; semantic
    search, reranking, clip formatting, tag suggestion, and query
    expansion each warn and either skip or fall back.

Any new feature that depends on an LLM provider or an optional extension
adds the degraded path in the same change. "Works only when Ollama is up"
is a bug, not a limitation.

## R5. Migrations are forward-only, `PRAGMA user_version`, one per transaction

`migrate()` in `src/core/db.ts` walks `MIGRATIONS` in order, applying any
whose `version` exceeds the current `user_version`, each inside its own
`BEGIN … COMMIT` (rolled back on error). To change the schema, **append**
a new entry to `MIGRATIONS` with the next integer version and a `.sql`
file under `src/core/migrations/`; never edit a shipped migration in
place (existing databases already ran it).

The FTS tokenizer and vector dimensions are template parameters baked in
at migration time (`{{FTS_TOKENIZE}}`, `{{VEC_DIMENSIONS}}`) and recorded
in `meta` (`fts_tokenizer`, `embedding_model`, `embedding_dimensions`).
Read them back from `meta`; never assume a value.

## R6. Tokenizer and embedding identity live in `meta`, not in code

`meta.fts_tokenizer` is per-database (chosen at first open from whether
vaporetto loaded). Code must read it — a binary that loaded vaporetto can
still be pointed at a trigram database and vice versa. Likewise
`embedding_model` / `embedding_dimensions`: a model change is detected by
comparing config against `meta`, and requires `kura doctor --fix` +
`kura embed` to re-vectorize. Don't silently re-embed against a
mismatched dimension.

## R7. `--json` output shapes are stable contracts

Every `--json` payload is consumed by the MCP server (`src/server/mcp.ts`)
and by external agents. A field rename or shape change is a breaking
change:

1. Update the MCP tool schema and any consuming skill text in the same PR.
2. Add a `CHANGELOG.md` "Unreleased" entry (breaking).
3. Update the matching `.claude/docs/` page (mcp-server.md /
   cli-reference.md / http-api.md).

## R8. Exit codes come from typed errors, not scattered `process.exit`

`src/core/errors.ts` defines the mapping the CLI layer honors:

| Throw | Exit |
|---|---|
| `UsageError` | 2 |
| `NotFoundError` | 3 |
| `ConflictError` / any other `Error` | 1 |
| `LLMUnavailableError` | 4 |
| (success) | 0 |

Core throws the typed error; the CLI entry point (`src/cli/index.ts`)
translates it to the exit code. Don't `process.exit(n)` from `src/core/`
— it can't be tested and bypasses the mapping.

## R9. Server and MCP handlers reuse `src/core/`

`src/server/` (REST API, `Bun.serve`, MCP) must call into `src/core/`.
No business logic — search ranking, document mutation, link resolution —
is duplicated in a handler. A behavior that exists in both the CLI and
the API exists once, in core.
