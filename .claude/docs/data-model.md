# Data Model

> Covers SPEC §3. Key sources: `src/core/migrations/001_init.sql`, `src/core/migrations/002_document_paths.sql`, `src/core/migrations/003_favorites.sql`, `src/core/migrations/004_aliases.sql`, `src/core/migrations/005_revisions.sql`, `src/core/db.ts`, `src/core/documents.ts`, `src/core/aliases.ts`, `src/core/revisions.ts`, `src/core/doctor.ts`, `src/core/frontmatter.ts`

Schema v1 lives in `src/core/migrations/001_init.sql`; schema v2
(`002_document_paths.sql`) adds hierarchical document paths, schema v3
(`003_favorites.sql`) the `favorite` flag, schema v4
(`004_aliases.sql`) document aliases, and schema v5
(`005_revisions.sql`) document revisions (see the `documents` /
`document_aliases` / `document_revisions` tables and the migration-runner
section below). Two placeholders are substituted into `001_init.sql` (and
`{{FTS_TOKENIZE}}` again into `004_aliases.sql`) by the migration runner at
apply time: `{{FTS_TOKENIZE}}` (`vaporetto` or `trigram`) and
`{{VEC_DIMENSIONS}}` (embedding dimensions). All derived tables are kept in
sync by the repository layer — see the invariants in
[architecture.md](architecture.md).

## Tables

### `buckets`

Top-level knowledge categories. Seeded with `('main', 'Default bucket')`.

| Column | Meaning / constraints |
| --- | --- |
| `id` | PK |
| `name` | UNIQUE. Lowercase alphanumerics and `-`, must start alphanumeric (`NAME_RE` in `src/core/buckets.ts`) |
| `description` | Optional free text |
| `created_at` | Default `datetime('now')` (UTC) |

Buckets can only be deleted when empty (`deleteBucket`); renames keep `id`
so document/link references survive.

### `documents`

The single source of truth for document bodies.

| Column | Meaning / constraints |
| --- | --- |
| `id` | PK. Also the `documents_fts` rowid and FK target for links/chunks/tags |
| `doc_key` | UNIQUE 8-hex public short ID (see "doc_key" below) |
| `bucket_id` | FK → `buckets(id)` |
| `path` | Slash-separated folder-like namespace; `''` = bucket root. `NOT NULL DEFAULT ''` (schema v2). Normalized on write (`normalizeDocPath` in `src/core/wiki.ts`: trim segments, drop empty segments) — **case-preserving**, unlike tag paths |
| `title` | Trimmed, non-empty. May contain a literal `/` — the `path` column, not the title, carries hierarchy. `UNIQUE (bucket_id, path, title)` in DDL (schema v2); the repository additionally enforces **case-insensitive** uniqueness of the **computed full path** (`path === '' ? title : path + '/' + title` — `assertUniqueInBucket` in `src/core/documents.ts`), which also rejects cross-form collisions like `path='a', title='b/c'` vs `path='a/b', title='c'` so full-path references stay unambiguous |
| `content` | Full body (Markdown or raw HTML) |
| `content_type` | `'markdown'` (default) or `'html'`; anything else is read back as `'markdown'` |
| `source_url` | Origin URL for `kura clip` documents; nullable |
| `content_hash` | sha256 hex of `content`; drives re-chunk decisions and `doctor` repair |
| `created_at` / `updated_at` | SQLite UTC format (see "Timestamps") |
| `last_accessed_at` | Nullable; set by `touchAccess` (CLI `get`, MCP `kura_get`, API doc fetch) |
| `access_count` | Incremented by `touchAccess` |
| `favorite` | `0` / `1`, `NOT NULL DEFAULT 0` (schema v3). Pins the document to the browser sidebar (docs: [browser-ui.md](browser-ui.md)). Written **only** by `setFavorite` — never by `updateDocument`, so starring leaves `updated_at` alone |

Indexes: `idx_documents_bucket`, `idx_documents_updated`,
`idx_documents_favorite` (partial, `WHERE favorite = 1`).

### `tags` / `document_tags`

`tags.path` is UNIQUE and always stored normalized (lowercased, slashes
trimmed/collapsed — `normalizeTagPath` in `src/core/wiki.ts`). Hierarchy is
purely lexical (`tech/db/sqlite`); there is no parent row requirement, and
tag filters match descendants via `path = ? OR path LIKE ? || '/%'`.

`document_tags(document_id, tag_id)` is the composite PK, both FKs `ON
DELETE CASCADE`. `source` is `'manual'` (default; body hashtags, frontmatter,
`kura tag add`) or `'auto'` (LLM suggestions applied by `kura tag suggest
--apply` / `kura clip`).

### `document_aliases`

Alternate titles (schema v4), one row per alias. Aliases join wiki-link /
`resolveDoc` resolution as a third stage and are FTS-indexed, so
orthographic variants (サーバ/サーバー) and abbreviations find the document
(see [document-notation.md](document-notation.md)).

| Column | Meaning / constraints |
| --- | --- |
| `id` | PK (aliases list in creation order) |
| `document_id` | FK → documents, `ON DELETE CASCADE` |
| `alias` | Case-preserving free text; matching is case-insensitive. May not contain `[`, `]`, `\|`, `/`, or newlines (`normalizeAlias` in `src/core/wiki.ts`) |

Indexes: `idx_document_aliases_doc_alias` — UNIQUE on
`(document_id, lower(alias))` — and `idx_document_aliases_alias` on
`lower(alias)` for resolution lookups. Writes go through
`src/core/aliases.ts` (`addAliasesToDoc` / `removeAliasesFromDoc` /
`setAliasesForDoc`), which refresh the FTS `aliases` column and re-run link
resolution in the same transaction; an alias equal to the document's own
title is silently skipped on add.

### `document_revisions`

Edit history (schema v5). `updateDocument` snapshots the state being
**replaced** — inside the same save transaction — whenever content, title,
or path changed (`snapshotRevision` in `src/core/revisions.ts`; no SQL
triggers, per `invariants.md` R1/R2). Surfaced by `kura history` and
`kura get --as-of` (docs: [cli-reference.md](cli-reference.md)).

| Column | Meaning / constraints |
| --- | --- |
| `id` | PK; also the public revision id (`r12`) |
| `document_id` | FK → documents, `ON DELETE CASCADE` — history does not survive deletion |
| `title` / `path` / `content` / `content_hash` | The replaced state, verbatim |
| `saved_at` | The `updated_at` the state carried while it was current |
| `created_at` | When the snapshot row was written (drives coalescing) |

Index: `idx_document_revisions_doc` on `(document_id, id)`.

Write semantics (`snapshotRevision`):

- **Dedup** — skipped when the state equals the newest revision
  (`content_hash` + `title` + `path`).
- **Coalescing** — skipped when the newest revision was written within
  `COALESCE_MINUTES` (5) — browser-autosave bursts collapse into one
  revision per burst, keeping the state from before the burst. A title or
  path change passes `force` and always snapshots.
- **Pruning** — after insert, only the newest `MAX_REVISIONS_PER_DOC`
  (100) rows per document are kept.
- A **pure bucket move** is not snapshotted — revisions track content and
  naming, not which bucket a document lives in. Metadata-only updates
  (tags, aliases, favorite, access) never snapshot.

Point-in-time reads (`stateAsOf`): the newest state — current row or
revision — whose `saved_at` is `<= asOf`; `null` when the document has no
recorded state that old (created later, or the snapshot was pruned).
Consumers: `kura get --as-of` and `kura history`. The change feed
(`changesSince` in `src/core/changes.ts` — `kura changes` / MCP
`kura_changes`) uses the leaner `revisionMetaAsOf` (title / path /
`content_hash` only, no bodies) to diff the current row against the state
as of `--since` and flag renames and moves.

### `links`

One row per distinct `[[target]]` in a document body.

| Column | Meaning / constraints |
| --- | --- |
| `source_id` | FK → documents, `ON DELETE CASCADE` |
| `target_id` | FK → documents, `ON DELETE SET NULL` — a deleted target turns the link back into an unresolved one |
| `target_title` | Raw (trimmed) text inside `[[...]]`; preserved even while unresolved |
| — | `UNIQUE (source_id, target_title)`; partial index `idx_links_unresolved` on `target_title WHERE target_id IS NULL` |

`syncLinks` (`src/core/links.ts`) deletes and re-inserts a document's rows on
every save, resolving each `target_id` through `resolveLinkTarget` — the
shared three-stage, bucket-scoped, case-insensitive resolution (computed full
path first, then title, then alias, each resolved only when exactly one
candidate exists; see [document-notation.md](document-notation.md)).
Self-links resolve to NULL.

### `chunks`

The unit of embedding, rebuilt from the body by `rebuildChunks`
(`src/core/documents.ts`) using `src/core/chunker.ts`.

| Column | Meaning / constraints |
| --- | --- |
| `document_id` | FK → documents, `ON DELETE CASCADE` |
| `seq` | 0-based order; `UNIQUE (document_id, seq)` |
| `text` | Chunk text with a `# {title} > {nearest heading}` context header prepended (embedding input) |
| `start_offset` | UTF-16 offset of the raw chunk within the body (for line jumps) |
| `embedded_at` | `NULL` = embedding pending (backfill target); set per-chunk by `backfillEmbeddings` |

### `documents_fts` (FTS5 virtual table)

`fts5(title, content, tags, aliases, tokenize='{{FTS_TOKENIZE}}')` (the
`aliases` column since schema v4).

- **`rowid` = `documents.id`.** Every insert passes the rowid explicitly.
- Standard (not contentless) so `snippet()` / `highlight()` work; storage
  duplication is acceptable at ~10k docs.
- The `tags` and `aliases` columns are **synthesized** at write time
  (space-joined tag paths / aliases) — this is why sync cannot be done with
  SQL triggers. Helpers live in `src/core/fts.ts`; tag-only changes call
  `ftsRefreshTags`, alias-only changes `ftsRefreshAliases`.
- BM25 column weights at query time: title 5.0, content 1.0, tags 3.0,
  aliases 5.0 (an alias is an alternate title).

### `chunks_vec` (sqlite-vec `vec0` virtual table)

`vec0(chunk_id INTEGER PRIMARY KEY, embedding float[{{VEC_DIMENSIONS}}])`.

- **`chunk_id` corresponds to `chunks.id`** — not enforced by FK (virtual
  tables have none), so the repository deletes vec rows explicitly before
  deleting chunks or documents, and `doctor --fix` GCs orphans.
- **vec0 caveats**: `changes`/`result.changes` after DML on vec0 is
  unreliable — when a count matters, `SELECT COUNT(*)` **before** deleting
  (see `gcOrphans` in `src/core/doctor.ts`). There is no upsert; the
  backfill does `DELETE` then `INSERT` per chunk
  (`src/core/search/vector.ts`).
- Query pattern: `WHERE embedding MATCH ? AND k = ?` returning `distance`.

### `llm_cache`

Keyed by `cache_key = sha256(purpose + model + input)`; `purpose` is one of
`'expand' | 'rerank' | 'tag' | 'clip' | 'path' | 'ask' | 'audit'`; `value` is JSON. Managed
by `src/core/llm/cache.ts`.

### `meta`

Key/value system metadata; accessors `getMeta` / `setMeta` in
`src/core/db.ts`. Key ledger:

| Key | Written by | Read by |
| --- | --- | --- |
| `fts_tokenizer` | `openDatabase` on fresh-DB creation (vaporetto if it loaded, else trigram); `retokenizeFts` on `doctor --fix` reindex | `openDatabase` for existing DBs (tokenizer choice + mismatch warning), `keywordSearch` callers, `src/core/stats.ts`, `doctor` |
| `embedding_model` | `openDatabase` (fresh DB), `kura embed` after a successful run, `recreateVecIfModelChanged` (`doctor --fix`) | `doctor` config-drift detection, `stats.ts` |
| `embedding_dimensions` | Same three writers | `openDatabase` (migration context for existing DBs — the DB's real dimensions win over config), `doctor` drift detection |

The schema version is **not** in `meta`; it lives in `PRAGMA user_version`.

## Migration runner

`migrate()` in `src/core/db.ts`:

- Versioning via `PRAGMA user_version` (0 = fresh). `MIGRATIONS` is an
  ordered array of `{ version, render(ctx) }`; every entry with `version >
  user_version` is applied. An optional `upTo` parameter caps the target
  version — tests use it to build old-schema databases
  (`tests/migration.test.ts`).
- `render` substitutes `{{FTS_TOKENIZE}}` / `{{VEC_DIMENSIONS}}` from
  `MigrateContext`. For a fresh DB the context comes from the vaporetto load
  result + config; for an existing DB it comes from `meta` so re-renders
  match what the DB was actually built with.
- Each migration runs inside its own `BEGIN … COMMIT` with `ROLLBACK` on
  error, and sets `PRAGMA user_version` inside that transaction.
- The runner toggles `PRAGMA foreign_keys = OFF/ON` around each migration —
  **outside** the transaction, where the pragma would be a no-op. A table
  rebuild's `DROP TABLE` would otherwise fire the `ON DELETE` actions on
  child tables. `PRAGMA foreign_key_check` runs before `COMMIT` to keep the
  safety the pragma provided (sqlite.org/lang_altertable.html §7); any
  violation rolls the migration back.
- **Schema v2** (`002_document_paths.sql`) rebuilds `documents` to change
  `UNIQUE (bucket_id, title)` into `UNIQUE (bucket_id, path, title)`,
  **preserving ids** — the `documents_fts` rowid and the
  `links` / `document_tags` / `chunks` FKs all reference `documents.id` — and
  recreating the two indexes. Every existing row gets `path = ''`, so an
  upgraded database's meaning is unchanged. Migrations are forward-only;
  there is no down path.
- **Schema v3** (`003_favorites.sql`) adds `documents.favorite` with a plain
  `ALTER TABLE … ADD COLUMN` (no rebuild) plus a partial index. Existing
  documents default to unpinned.
- **Schema v4** (`004_aliases.sql`) creates `document_aliases` and rebuilds
  `documents_fts` with the `aliases` column — FTS5 has no
  `ALTER TABLE … ADD COLUMN`, so the migration drops the virtual table,
  recreates it with `tokenize='{{FTS_TOKENIZE}}'` (this is why `render`
  substitutes the tokenizer again for v4), and repopulates
  title/content/tags from `documents` + `document_tags`; the `aliases`
  column starts empty because `document_aliases` was just created.
- **Schema v5** (`005_revisions.sql`) creates `document_revisions` plus its
  index — a plain additive migration with no placeholders and no rebuild.
  Existing documents start with empty history; snapshots begin with the
  first post-upgrade edit.

**Adding a migration**: create `src/core/migrations/00N_name.sql`, import it
in `db.ts` with `with { type: "text" }`, append `{ version: N, render }` to
`MIGRATIONS`. If the SQL needs new placeholders, extend `MigrateContext` and
substitute them in `render`. Never edit `001_init.sql` retroactively —
existing DBs will not re-run it.

## doc_key

- **Generation** (`generateDocKey`, `src/core/documents.ts`): first 8 hex
  chars of `sha256("{title}:{content}:{random}")` where `random` is two
  `crypto.getRandomValues` words. On collision with an existing key, retry
  with fresh randomness until unique. Shape: `/^[0-9a-f]{8}$/`.
- Import can supply a key for round-trips (`kura_key` in frontmatter): an
  invalid shape is a `UsageError`; a key already owned by another document is
  silently replaced with a freshly generated one (create path) — a matching
  key means "update this document" instead (`importDocument`).
- **Resolution** (`resolveDoc`): a `<doc>` specifier is, in order —
  1. `#key` — must be valid 8-hex (else `UsageError`); unknown → `NotFoundError`.
  2. bare 8-hex string — tried as a key first, then falls through.
  3. computed full path — case-insensitive match on
     `path === '' ? title : path + '/' + title`, scoped to `--bucket` when
     given. Unique per bucket by construction, so several matches means
     several buckets → `ConflictError` (use `#key` or `--bucket`).
  4. title — case-insensitive match, scoped to `--bucket` when given,
     otherwise across all buckets. Exactly one match resolves;
     multiple matches (possible even inside one bucket now, under different
     paths) → `ConflictError` listing `#key (bucket, path/)` candidates
     (exit 1; use `#key`, the full path, or `--bucket`).
  5. alias — case-insensitive match against `document_aliases`, same
     scoping. Exactly one document resolves; multiple → `ConflictError`;
     zero → `NotFoundError` (exit 3).
- **YAML lesson**: an all-digit key (`16052989`) or an exponent-like key
  (`12e45678`) is coerced to a number by YAML if unquoted. Export therefore
  always quotes `kura_key`, and the parser rescues hand-written unquoted
  integer keys back into strings. See [document-notation.md](document-notation.md)
  and the regression test in `tests/documents.test.ts`.

## Timestamps

- The DB stores SQLite's `datetime('now')` format: **`"YYYY-MM-DD
  HH:MM:SS"`, UTC, no timezone suffix** — via DDL defaults, `sqliteNow()` in
  `src/core/documents.ts`, and `datetime('now')` in `touchAccess`.
- Conversion to/from ISO 8601 happens **only at the frontmatter boundary**
  (`src/core/frontmatter.ts`): `toSqliteDatetime` on import (accepts
  anything `Date`-parsable), `toIsoDatetime` on export (space → `T`, append
  `Z`). CLI JSON output, the REST API, and the SPA all pass the SQLite form
  through unchanged.

## Consistency rules (SPEC §3.2)

- Every documents write syncs `documents_fts` / `links` / `document_tags` /
  `chunks` in the same transaction (`syncDerived`); `updateDocument` also
  snapshots the replaced state into `document_revisions` in that same
  transaction when content, title, or path changed (see the table section
  above). Alias writes (`src/core/aliases.ts`) run in their own transaction
  and sync the FTS `aliases` column plus link resolution. The two exceptions are
  `touchAccess` (`access_count` / `last_accessed_at`) and `setFavorite`
  (`favorite`): both write a column that no derived table reads, so they skip
  `syncDerived` — and `setFavorite` deliberately also skips the `updated_at`
  bump, because starring a document is not editing it. They still belong to
  the repository layer (`invariants.md` R1); nothing outside it writes
  `documents`.
- **Re-chunking**: `updateDocument` compares `sha256(new content)` with the
  stored `content_hash` and rebuilds chunks only on change (deleting the
  matching `chunks_vec` rows; new chunks start with `embedded_at = NULL` for
  lazy backfill). Chunks are *also* rebuilt on a title-only change because
  the chunk context header embeds the title.
- **Rename / move** (`kura mv` → `updateDocument`): same-bucket referrers'
  bodies are rewritten via `replaceWikiLinkTargets` (recursively through
  `updateDocument`, so each referrer re-syncs) per this matrix —
  a **title change** rewrites both `[[旧タイトル]]` and the full-path spelling
  `[[old/full/path]]`, pointing the short form at the **new full path** when
  the new title alone would be ambiguous in the bucket; a **path-only move**
  rewrites only the full-path spelling (short `[[title]]` links keep their
  `target_id` and stay valid); a **bucket move** rewrites nothing and instead
  **unresolves** incoming links (link scope is per bucket). Self-links are
  rewritten too, and any unresolved links matching the new title / full path
  are resolved afterwards.
- **Embedding config drift**: `doctor` compares config
  `embedding_model` / `embedding_dimensions` against `meta`
  (`recreateVecIfModelChanged`); on mismatch it drops and recreates
  `chunks_vec` with the new dimensions, sets all `chunks.embedded_at = NULL`,
  updates `meta`, and tells the user to run `kura embed`. `backfillEmbeddings`
  also hard-fails if a returned vector's length differs from the configured
  dimensions.
- `doctor --fix` additionally repairs: FTS/documents row-count mismatch
  (rebuild), orphaned chunks/vec rows (GC), stale `content_hash` (recompute +
  re-chunk), and bulk-resolves unresolved links (`src/core/doctor.ts`).

## Deviations from SPEC

- **FTS tokenizer DDL (§3.1)**: SPEC embeds a model path
  (`tokenize='vaporetto model {KURA_HOME}/lib/{ver}/….model.zst'`); the
  actual DDL uses a bare `tokenize='vaporetto'` (or `trigram`) — the
  morphological model is compiled into the sqlite-vaporetto "with-model"
  build downloaded by `src/core/bootstrap.ts`, so no path argument exists.
- **`schema_version` meta key (§3.1 comment)**: not stored in `meta`; the
  version lives only in `PRAGMA user_version`.
- **Re-chunk trigger (§3.2)**: SPEC says re-chunk only when `content_hash`
  changed; the implementation also re-chunks on title-only renames (context
  headers contain the title).
- **doc_key seed (§3.1)**: SPEC says "hash of content + randomness"; the
  seed actually includes the title too (`title:content:random`). Cosmetic —
  uniqueness comes from the randomness + collision retry.
- **Hierarchical document paths (schema v2)**: SPEC §3.1 has no `path`
  column and specifies `UNIQUE (bucket_id, title)`; migration 002 adds
  `path TEXT NOT NULL DEFAULT ''` and relaxes the constraint to
  `UNIQUE (bucket_id, path, title)`, so same-title documents can coexist in
  one bucket under different paths.
- **Favorites (schema v3)**: SPEC §3.1 has no `favorite` column. It exists
  for the browser sidebar and is deliberately a boolean column rather than a
  table — a favorite carries no attributes of its own, so nothing about it
  would be worth a row (docs: [browser-ui.md](browser-ui.md)).
- **Aliases (schema v4)**: SPEC §3.1 has no `document_aliases` table and §4
  resolves links by title only; aliases (with the FTS `aliases` column and
  the third resolution stage) are an implementation addition
  (docs: [document-notation.md](document-notation.md)).
- **Revisions (schema v5)**: SPEC §3.1 has no `document_revisions` table;
  edit history, `kura history`, and `kura get --as-of` are an
  implementation addition. Updates were destructive before v5.
- **Case-insensitive uniqueness**: the DDL UNIQUE constraint is
  case-sensitive; the repository additionally rejects case-insensitive
  duplicates of the computed full path, which SPEC doesn't state explicitly.
- **Bucket moves**: unresolving incoming links when a document changes
  bucket is implementation-defined behavior not covered by SPEC.
- **Import creates buckets**: `importDocument` auto-creates a missing bucket
  (`getOrCreateBucket`); SPEC §7.2 doesn't specify this.
