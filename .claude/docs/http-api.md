# HTTP API

> Covers SPEC §8.1–8.2. Key sources: `src/server/http.ts`, `src/server/api.ts`,
> `src/cli/commands/browser.ts`; contract tests in `tests/api.test.ts`.

The REST API exists to serve the browser UI ([browser-ui.md](browser-ui.md))
and nothing else. It is a thin HTTP skin over `src/core/`; handlers contain
routing, parameter parsing, and JSON shaping only — **all domain logic lives
in core** and is shared with the CLI and the MCP server.

## Server behavior

`startServer()` in `src/server/http.ts` wires everything; `kura browser`
(`src/cli/commands/browser.ts`) is the CLI entry point that calls it and stays
resident until SIGINT/SIGTERM.

### Binding and authentication

- The server binds to **`127.0.0.1` only** and has **no authentication**.
  This is deliberate: kura is a local, single-user tool (SPEC §1.2 non-goals
  exclude multi-user and sync), so the loopback interface *is* the security
  boundary. Never change the hostname to `0.0.0.0` or add a `--host` flag
  without a design discussion — auth would have to come with it.
- Because there is no auth, nothing in the API may trigger outbound network
  access on behalf of a caller beyond what core already does (localhost LLM
  providers). See the network policy in `CLAUDE.md`.

### Port selection

- Default port is **7578** (`browser.port` in config, see
  [configuration.md](configuration.md)); `kura browser --port` overrides it.
- On `EADDRINUSE`, `startServer()` increments the port by 1 and retries, up
  to **10 attempts** (7578–7587 by default). Any other bind error is
  re-thrown immediately. After 10 failures it throws
  `ports N-N+9 are all in use`.
- Tests pass `port: 0` to let the OS assign an ephemeral port; the returned
  `KuraServer` exposes the actual `port`, a ready-made `url`
  (`http://127.0.0.1:<port>`), and `stop()`.

### Routing model

- API routes are declared as a **`Bun.serve({ routes })` table** built by
  `createApiRoutes()` in `src/server/api.ts`. Path parameters use Bun's
  `:key` syntax; per-method handlers are objects (`{ GET, PUT, DELETE }`).
- Every handler is wrapped by `wrap()`, which catches anything thrown and
  converts it via `errorResponse()` (see the error table below). Handlers
  therefore just throw core errors; they never build error responses by hand.
- Requests that match no route fall through to the `fetch` fallback:
  - Paths under `/api/` return `404 {"error": "not found"}` (JSON, never
    HTML).
  - Anything else goes to asset resolution / SPA fallback.

### Asset resolution and SPA fallback

Assets are resolved by an `AssetResolver` chosen in this order:

1. An explicit `assets` resolver passed to `startServer()` (tests use
   `distAssetResolver(dist)` directly).
2. `embeddedAssetResolver()` — files embedded into the compiled binary via
   `src/generated/embedded.ts`. In development this module is a stub with an
   empty table, so the resolver returns `null` and step 3 applies. See
   [build-and-release.md](build-and-release.md).
3. `distAssetResolver(<repo>/dist)` — files produced by `bun run
   build:client` (`scripts/build-html.ts`).

For a non-`/api/` path the server tries the resolver with the path, then with
`/` (SPA fallback: unknown client-side routes such as `/docs/abc12345` get
`index.html` so wouter can route). If even `index.html` is missing (fresh
clone, no build yet) a small **placeholder HTML page** is served explaining
how to build, so the REST API remains usable without the SPA.

`distAssetResolver` rejects paths containing `..`. Content types come from a
fixed extension map; unknown extensions are `application/octet-stream`.

## Error mapping

`errorResponse()` maps core error classes (`src/core/errors.ts`) to HTTP
statuses. The body is always `{"error": "<message>"}`.

| Thrown | Status | Typical cause |
| --- | --- | --- |
| `NotFoundError` | 404 | unknown doc key |
| `UsageError` | 400 | bad `sort`, bad `mode`, missing `q` |
| `ConflictError` | 409 | PUT rename onto an existing title in the bucket |
| anything else (incl. `LLMUnavailableError`) | 500 | provider down in `mode=vector`, bugs |

Note that `LLMUnavailableError` intentionally has no dedicated status: the UI
treats "no provider" as a server-side degradation message, and hybrid mode
never throws it (it degrades with warnings instead).

## Common JSON shapes

- **Document** (`docJson()`): `key`, `path` (slash-separated document path,
  `""` = bucket root), `title`, `bucket`, `tags` (string array),
  `content_type`, `source_url`, `created_at`, `updated_at`,
  `last_accessed_at`, `access_count`, plus `content` where noted. Timestamps
  are SQLite `YYYY-MM-DD HH:MM:SS` strings (UTC).
- **Search hit** (`hitJson()`): `key`, `path`, `title`, `bucket`, `tags`,
  `score`, `snippet` (matches wrapped in `**…**`), `source`
  (`keyword` | `vector` | `hybrid`).

`src/client/api.ts` mirrors these shapes as TypeScript interfaces; keep the
two in sync when changing a response.

## Endpoint reference

### `GET /api/stats`

Dashboard statistics via `collectStats()` (`src/core/stats.ts`). Response
keys: `documents`, `buckets` (`[{name, documents}]`), `tags`, `chunks`,
`embeddedChunks`, `embeddingCoverage` (0–1; 1 when there are no chunks),
`staleDocuments`, `unresolvedLinks`, `dbSizeBytes`, `tokenizer`,
`embeddingModel` (nullable).

### `GET /api/insights`

Tidying findings for one bucket via `collectInsights()`
(`src/core/insights.ts`), backing the statistics screen. Optional `bucket`
(defaults to `general.default_bucket`); an unknown bucket is a 404.

```
{ orphans:  { count, docs: [{key, title, path}] },   // no resolved link either way
  untagged: { count, docs: [...] },
  unfiled:  { count, docs: [...] },                  // still at the bucket root
  brokenLinks: { count, links: [{targetTitle, sources: [{key, title}]}] },
  tagDuplicates: [{from, to, reason, similarity}] }
```

Each `docs` array is capped at 50 while `count` stays exact. The document
lists are projected queries (`key`, `path`, `title` — a statistics page must
not read the bodies of a whole bucket to draw a count), the broken links come
from `brokenLinks()`, and the duplicate tags from `tagMergeCandidates()` —
the **synchronous, edit-distance half** of the gardening audit, split out of
`auditTags()` precisely so this endpoint needs no LLM and no `await`
(`invariants.md` R4). Nothing is repaired here: the UI shows the findings and
names the CLI command that fixes them.

### `GET /api/buckets`

Array of `{id, name, description, createdAt, documents}` from
`listBuckets()`, ordered by name.

### `GET /api/docs`

Paged document listing (metadata only, no `content`).

| Query param | Default | Notes |
| --- | --- | --- |
| `bucket` | all buckets | exact bucket name |
| `tag` | — | hierarchical: matches the tag itself **and descendants** (`t.path = ? OR t.path LIKE ? || '/%'`) |
| `prefix` | — | document-path filter: matches the path itself **and descendants**, case-insensitively. Normalized (`normalizeDocPath`); a value that normalizes to `""` → 400 |
| `sort` | `updated` | one of `updated` / `created` / `accessed` / `title`; anything else → 400 |
| `stale` | off | `stale=1` keeps only docs with `updated_at` older than `general.stale_days` |
| `page` | 1 | clamped to ≥ 1 |
| `per` | 50 | **capped at 200**; non-numeric input falls back to the default |

Response: `{docs: Document[], total, page, per}`. `total` is computed with
the same filter by `listDocumentsCount()` so the UI can render pagination.

### `GET /api/docs/tree`

Per-bucket document-path hierarchy for the sidebar, via `docTree()` /
`buildDocTree()` (`src/core/documents.ts`, mirroring `buildTagTree`).

| Query param | Default | Notes |
| --- | --- | --- |
| `bucket` | **required** | titles are bucket-scoped, so the tree is too; missing → 400 |

Response: `DocTreeNode[]` — `{segment, path, key?, total, children}`.
Branch nodes come from path prefixes (`key` absent); document nodes carry
their `doc_key` as `key`; a branch whose path equals a document's computed
full path is merged (both `key` and `children`). Subtrees sort before
documents, then alphabetically. Note the static route must keep winning
over `/api/docs/:key` (Bun.serve prefers exact segments over params).

### `GET /api/resolve`

Doc-specifier resolution for the browser's wiki-link navigation — a thin
wrapper over `resolveDoc()` (`src/core/documents.ts`), accepting the same
grammar as the CLI: key / `#key` / full path / unique title.

| Query param | Default | Notes |
| --- | --- | --- |
| `doc` | **required** | the specifier; trimmed, empty → 400 |
| `bucket` | all buckets | scopes full-path / title resolution |

Responses: `200` with the document JSON (metadata only, no `content`; **no
`touchAccess` side effect**, unlike `GET /api/docs/:key`); `404`
(`NotFoundError`) when nothing matches; `409` (`ConflictError`) when the
specifier is ambiguous — the candidate list (keys, buckets, paths) is the
`error` message string.

### `GET /api/docs/:key`

Full document (**including `content`**) by `doc_key`. Side effect: calls
`touchAccess()`, so every GET **increments `access_count`** and stamps
`last_accessed_at` (SPEC §3.1); the response already reflects the
incremented count. 404 when the key is unknown.

### `PUT /api/docs/:key`

Body: `{title?, path?, content?, tags?}` (all optional). This is the
browser editor's save path and re-parses the body exactly like a CLI edit
(`updateDocument()` re-extracts `[[links]]` and `#hashtags`, re-syncs FTS,
rebuilds chunks when content or title changed, and rewrites `[[old title]]`
/ `[[old/full/path]]` in referring documents on rename or move — see
[document-notation.md](document-notation.md)). `path` moves the document
(`""` = bucket root).

**Tag diff-sync semantics**: unlike the repository layer (add-only), the PUT
handler treats `tags` as the *complete* desired tag set — the editor state is
the source of truth. It removes tags present on the document but absent from
the array, then adds the new ones, then calls `updateDocument()`. Caveat:
hashtags still written inline in the body are re-extracted on save, so a tag
cannot be removed via the array while `#tag` remains in the content.
Omitting `tags` (or sending a non-array) leaves tags untouched.

Returns the updated document including `content`. Renaming or moving onto
an existing computed full path in the same bucket → 409.

### `DELETE /api/docs/:key`

Deletes the document (FTS/chunks/vec rows cleaned up in the same
transaction; incoming links revert to unresolved). Response:
`{deleted: "<key>"}`.

### `GET /api/docs/:key/related`

Link neighborhood for the detail sidebar:

```
{ outlinks: [{target_title, target: {key,title,bucket} | null}],
  backlinks: [{key,title,bucket}],
  twoHop:    [{via: {key,title,bucket}, docs: [{key,title,bucket}]}] }
```

`target: null` marks an unresolved link. Two-hop groups are documents that
link to the same target (`twoHopLinks()` in `src/core/links.ts`), excluding
documents already directly linked.

### `GET /api/search`

| Query param | Default | Notes |
| --- | --- | --- |
| `q` | **required** | trimmed; empty → 400 |
| `mode` | `keyword` | `keyword` / `vector` / `hybrid`; anything else → 400 |
| `bucket`, `tag` | — | same filter semantics as `/api/docs` |
| `limit` | 20 | max hits returned |

Response: `{hits: Hit[], warnings: string[]}`. The three modes map onto the
search pipeline ([search-pipeline.md](search-pipeline.md)):

- **keyword** — `keywordSearch()` (FTS5 BM25). No LLM involved;
  `warnings` is always `[]`.
- **vector** — `requireProvider()` first, so with no reachable LLM provider
  this returns **500** (`LLMUnavailableError`). Before searching,
  `ensureEmbeddings()` auto-backfills up to 100 pending chunks or emits a
  warning about incomplete results.
- **hybrid** — `hybridQuery()`. **Never fails for LLM reasons**: with no
  provider it degrades to keyword-only and reports it in `warnings`
  (provider-unreachable, embedding backlog, rerank failure, etc.).

### `GET /api/tags`

Without params: flat array of `{path, count}` (direct-assignment counts),
ordered by path. With `?tree=1`: hierarchy built by `buildTagTree()` —
recursive nodes `{segment, path, count, total, children}` where `count` is
direct assignments (0 for intermediate nodes that are not tags themselves)
and `total` includes descendants.

Optional `bucket`: count only documents in that bucket, and drop tags it
does not use (`listTags(db, { bucket })`). Unscoped, the query `LEFT JOIN`s
so tags no document uses (count 0) stay visible to `kura tag gc` and the
gardening audit; scoped, those tags simply do not appear. The browser UI
always passes a bucket — every screen is scoped to the selected one
(docs: browser-ui.md).

### `GET /api/graph`

Knowledge-graph data for the d3-force view. Optional `bucket` / `tag`
filters (same semantics as `/api/docs`). Response:

```
{ nodes: [{key, title, tags, degree, stale}], edges: [{source, target}] }
```

Built by `buildGraph()` in `src/server/api.ts`:

- `edges` are **resolved** links only (`target_id IS NOT NULL`), expressed as
  doc-key pairs, and only when *both* endpoints survive the filter.
- `degree` counts both incoming and outgoing surviving edges per node
  (isolated nodes have `degree: 0`; the UI can hide them).
- `stale` compares `updated_at` against a cutoff computed from
  `general.stale_days` (UTC, formatted to match SQLite's timestamp format).

### `GET /api/llm`

`{provider: "ollama" | "lmstudio" | null}` from `resolveProvider()` (cached
detection, 60 s TTL). Lets the UI say whether vector/hybrid modes will work.
*Not in the SPEC baseline — see Deviations.*

## Adding an endpoint

1. Add the route to the table in `createApiRoutes()` (`src/server/api.ts`),
   wrapped in `wrap()`. Group methods on one path into a `{GET, PUT, ...}`
   object.
2. **Reuse `src/core/`** — if the logic doesn't exist there yet, add it to
   core first, then call it. No SQL or domain rules in `api.ts` beyond
   response shaping (`buildGraph`/`listDocumentsCount` are the current
   tolerated exceptions because they are purely presentational aggregation).
3. Validate params with `UsageError` for 400s; let core's `NotFoundError` /
   `ConflictError` surface naturally.
4. Add a test to `tests/api.test.ts` (in-memory DB, `setProviderForTests(null)`,
   `startServer({port: 0})`, real `fetch`).
5. Mirror the response type in `src/client/api.ts` if the UI consumes it,
   and update this document.

## Deviations from SPEC

- **`GET /api/llm` is an addition** — SPEC §8.2 does not list it. The SPA
  uses it to surface provider availability.
- **`GET /api/resolve` is an addition** — SPEC §8.2 does not list it; the
  SPA's wiki-link route uses it before falling back to search
  ([browser-ui.md](browser-ui.md)).
- **`prefix` on `/api/docs` is an addition** — hierarchical document paths
  post-date SPEC §8.2.
- **`limit` on `/api/search`** is an addition; SPEC lists only
  `q`, `mode`, `bucket`, `tag`.
- **`per` is capped at 200**; SPEC only specifies the default of 50.
- **No idle background embedding backfill** while the server runs. SPEC
  §5.3(3) planned embedding generation as idle work in `kura browser` /
  `kura mcp`; the implementation instead backfills small backlogs (≤ 100
  chunks) synchronously before vector/hybrid searches and points to
  `kura embed` otherwise.
- SPEC §8.2 sketches `PUT` as "update body/title/tags"; the tag **diff-sync**
  contract (array = complete set) and the inline-hashtag caveat are
  implementation-defined here.

## Related docs

- [browser-ui.md](browser-ui.md) — the only consumer of this API
- [search-pipeline.md](search-pipeline.md) — what the three modes do
- [mcp-server.md](mcp-server.md) — the agent-facing counterpart
- [architecture.md](architecture.md) — layering rules the handlers follow
