# MCP Server

> Covers SPEC §9. Key sources: `src/server/mcp.ts`,
> `src/cli/commands/mcp.ts`; contract tests in `tests/mcp.test.ts`.

`kura mcp` exposes the knowledge base to AI agents as a local MCP server. It
is the agent-facing sibling of the REST API ([http-api.md](http-api.md)):
both are thin layers over `src/core/`, and neither may duplicate domain
logic.

## Server construction

- Built on **`@modelcontextprotocol/sdk`**: `createMcpServer()` in
  `src/server/mcp.ts` returns an `McpServer` named `kura` (version =
  `KURA_VERSION`).
- **Dependency injection**: `createMcpServer({db, tokenizer, config})` takes
  the open database, the active FTS tokenizer, and the loaded config —
  the same `deps` shape as the REST API. This is what makes the server fully
  testable in-process (see Testing below); nothing inside `mcp.ts` opens
  connections or reads files.
- **Transport**: `kura mcp` (`src/cli/commands/mcp.ts`) connects a
  `StdioServerTransport` and then blocks until the client disconnects
  (`server.server.onclose`, i.e. stdin EOF). Logs must never go to stdout in
  this mode — stdout is the protocol channel.
- `kura mcp --print-config` prints ready-to-paste client configuration and
  exits without starting a server (see Client setup).

## Result conventions

- **Every tool returns a Markdown string** (`content: [{type: "text",
  text}]`) rather than structured JSON. This is deliberate (SPEC §9): MCP
  clients render text content directly, and Markdown keeps results readable
  in every host (Claude Code, inspector UIs, etc.) without client-side
  schema knowledge. Keys are embedded inline as `` `xxxxxxxx` `` code spans
  so agents can extract them reliably.
- **Errors never throw across the protocol.** Every handler wraps its body
  in `try/catch` and returns `errorResult(e)`: a text content of
  `error: <message>` with **`isError: true`**. Core errors (`NotFoundError`,
  `ConflictError`, `UsageError`) surface this way with their original
  messages.
- Search-style results share `hitsToMarkdown()`: optional warning lines as
  `> ⚠ …` blockquotes, one bullet per hit
  (`- **path/title** (key: \`key\`, bucket: …, tags: …)` — the bold part is
  the computed full path via `joinDocPath` — plus an indented snippet), and
  a closing hint line "Pass a key to `kura_get` to retrieve the full text."
  — the hint is part of the agent-guidance design, not decoration.

## Description design

Tool descriptions are written *for the calling agent*, not for humans, and
deliberately encode the intended workflow (SPEC §9):

- **`kura_query` first, then `kura_get`**: `kura_query`'s description says to
  search first and pass a hit's key to `kura_get`; `kura_get`'s description
  explains that `key` is the 8-character ID from search results. The
  cross-references are what steer agents through the two-step flow.
- **Disambiguation between the search tools**: `kura_query` points to
  `kura_search` "when speed or exact matches matter"; `kura_search` points
  back to `kura_query` "when semantic search is needed"; `kura_ask` points
  to `kura_query` "when you want raw hits instead of an answer".
- **Taxonomy reuse**: `kura_list_tags` tells agents to check the existing
  hierarchy *before* tagging, which keeps LLM-assigned tags convergent.
- Behavioral gotchas live in the description too: `kura_update` states that
  `content` replaces the whole body and that `tags` and `aliases` are
  add-only.

`tests/mcp.test.ts` asserts the guidance is present (e.g. `kura_query`'s
description must contain `kura_get`) — treat descriptions as tested API
surface, in English (see `CLAUDE.md` language conventions).

## Common input shapes

Search tools share `filterShape` (zod):

| Field | Schema | Meaning |
| --- | --- | --- |
| `bucket` | `string?` | filter by bucket name; all buckets when omitted |
| `tag` | `string?` | hierarchical tag filter, **descendants included** (e.g. `tech/db`) |
| `limit` | `int 1–50?` | max results |

Document specifiers (`key` fields) go through `resolveDoc()`
(`src/core/documents.ts`), so they accept a `doc_key`, **a full path**
(e.g. `clips/Title`), **a unique title, or a unique alias** — the schemas
describe them as "doc_key (8 characters), full path, or title". An
ambiguous title or alias returns a `ConflictError`-flavored error result
listing candidates with their buckets and paths.

## Tool reference (10 tools)

### `kura_query`

Hybrid search (keyword + semantic + rerank) via `hybridQuery()`
([search-pipeline.md](search-pipeline.md)).

- Input: `query` (string, natural language or keywords, Japanese supported)
  + `filterShape`. Default limit: `config.search.default_limit` (10).
- **Degrades, never fails**: with no LLM provider it answers keyword-only and
  prefixes `> ⚠ …` warning lines (provider unreachable, embedding backlog,
  rerank failure). Output: hit list Markdown as above.

### `kura_ask`

Answer generation with cited sources via `askQuestion()`
([search-pipeline.md](search-pipeline.md)) — hybrid search, then the
generation model answers strictly from the top 5 hits.

- Input: `question` (natural language, Japanese supported) + `filterShape`.
  Default limit: `config.search.default_limit` (10).
- Output: warning lines (`> ⚠ …`), the answer with `[1]`-style citations, a
  `## Sources` list (`- [n] **path/title** (key: \`key\`)` in citation
  order), and a hint to verify a source via `kura_get`.
- **Degrades, never fails**: with no provider, a generation failure, or zero
  hits, the answer is skipped and the standard hit list Markdown is returned
  instead (same shape as `kura_query`), with the warning explaining why.
- Answers are cached in `llm_cache` (purpose `ask`) keyed on the question
  plus each source's content hash.

### `kura_search`

Fast FTS5 BM25 keyword search via `keywordSearch()` — no LLM involved.

- Input: `query` (space-separated terms, OR search) + `filterShape`.
  Default limit: **10** (hardcoded; differs from the REST API's 20).
- Output: hit list Markdown (no warnings section).

### `kura_get`

Fetch a document body.

- Input: `key` (doc_key, full path, or title), `lines?` (`"START:END"`,
  1-based, either side optional, e.g. `"50:100"`, `":30"`; malformed →
  error result).
- **Side effect**: `touchAccess()` — increments `access_count` and stamps
  `last_accessed_at`, same as CLI `get` and REST GET (SPEC §3.1).
- Output: `# <title>` heading, a `>` metadata line (key, bucket, `path:`
  when non-empty, tags, `aliases:` when non-empty, source URL, updated),
  then the (optionally line-sliced) body.

### `kura_add`

Create a document via `createDocument()`.

- Input: `title` (path + title is unique within a bucket), `content`
  (Markdown), `bucket?` (defaults to `config.general.default_bucket`),
  `path?` (folder-like document path, e.g. `db/sqlite`; omit for the bucket
  root), `tags?` (string array, `/`-separated hierarchy), `aliases?`
  (alternate titles for `[[links]]` and search).
- The body is parsed like any other save: `[[Title]]` links and inline
  `#tag/path` hashtags are extracted, FTS/chunks synced, and unresolved
  links elsewhere pointing at this title, full path, or an alias resolve
  automatically ([document-notation.md](document-notation.md)).
- A duplicate computed full path in the bucket → error result
  (`ConflictError` message with the existing key).
  Output: `Added: **path/title** (key: ..., bucket: ...)`.

### `kura_update`

Update via `updateDocument()`.

- Input: `key` (doc_key, full path, or title), `content?` (**full body
  replacement**), `title?` (rename), `path?` (move; `''` moves to the
  bucket root), `tags?` (**add-only** — the repository merges them via
  `addTagsToDoc`; there is deliberately no tag removal over MCP, unlike the
  REST PUT's diff-sync), `aliases?` (**add-only** likewise, via
  `addAliasesToDoc`; removal is CLI `kura alias rm` / REST only).
- Rename and move automatically rewrite `[[links]]` in referring documents
  (rename: short title + full-path spelling; move: full-path spelling only —
  [document-notation.md](document-notation.md)); the output appends
  `(relinked N backlinks)` when that happened.
- Output: `Updated: **path/title** (key: ...)`.

### `kura_list_tags`

- Input: `prefix?` — lowercased path-segment prefix filter: keeps tags where
  `path === prefix` or `path` starts with `prefix + "/"` (so `tech` matches
  `tech/db` but not `technology`).
- Output: `- path (count)` per tag (direct-assignment counts), or
  `No tags found.`

### `kura_related`

Link neighborhood via `outlinks()` / `backlinks()` / `twoHopLinks()`.

- Input: `key` (doc_key, full path, or title).
- Output: `# Related documents for <title>` with three sections —
  `## Outlinks` (`[[title]] → key`, or `(not created yet)` for unresolved
  links), `## Backlinks`, and `## Two-hop links (documents sharing a link
  target)` grouped as `via [[shared target]]: docs...`. Empty sections say
  `(none)`.

### `kura_changes`

Change feed via `changesSince()` (`src/core/changes.ts`) — documents
created or updated since a point in time. The description tells agents to
call it at session start to catch up; pure SQL, works without an LLM
provider.

- Input: `since` (**required** — relative `30m` / `24h` / `7d` / `2w` or an
  ISO 8601 / `YYYY-MM-DD` date, normalized by `parseSince()`; unparsable →
  error result), `bucket?`, `limit?` (`int 1–200`, default 50). Its own
  schema, not `filterShape` — there is no `tag` filter.
- Output: `- **created**/**updated** path/title (key: \`key\`, bucket: b)
  at <updated_at>` bullets, with ` — content, renamed from 旧タイトル,
  moved from (root)` details where they apply (previous state derived from
  the revision history, [data-model.md](data-model.md)), plus a `kura_get`
  hint. An empty window returns `No changes since <since>.`.
- **Deletions are not tracked** — revisions are deleted with their
  document.

### `kura_status`

- Input: none (`inputSchema: {}`).
- Output: bullet-list statistics from `collectStats()` — documents, per-bucket
  counts, tags, chunks with embedding coverage %, stale candidates,
  unresolved links, DB size (MB), and active tokenizer.

## Testing

`tests/mcp.test.ts` exercises the real protocol without processes or pipes:

- **`InMemoryTransport.createLinkedPair()`** from the SDK links a real
  `Client` to the server created by `createMcpServer()` with an in-memory
  database — full MCP framing, zero I/O. Connect both ends with
  `Promise.all([server.connect(st), client.connect(ct)])`.
- **`setProviderForTests(null)`** (`src/core/llm/provider.ts`) pins "no LLM
  provider", making `kura_query` deterministic (degraded keyword-only mode
  with a `⚠` warning) — tests never touch a live Ollama/LM Studio. Reset
  with `setProviderForTests(undefined)` in `afterEach`.
- Patterns worth copying: assert the tool list and description guidance via
  `client.listTools()`; drive the search → extract key from Markdown → get
  flow and verify `access_count` in SQL; assert `isError` for unknown keys.
- Fixture content stays Japanese — these tests double as CJK search
  regressions ([testing.md](testing.md), `CLAUDE.md`).

## Client setup

`kura mcp --print-config` prints both snippets:

```sh
# Claude Code:
claude mcp add kura -- kura mcp
```

```json
{ "mcpServers": { "kura": { "command": "kura", "args": ["mcp"] } } }
```

The server uses the global `~/.kura` database (respecting `KURA_HOME` /
`KURA_DB`), so one registration serves every project.

## Adding a tool

1. `server.registerTool(name, {description, inputSchema}, handler)` in
   `createMcpServer()` (`src/server/mcp.ts`). Names are `kura_`-prefixed
   snake_case.
2. Write the **description for agents**: state when to use it, when to use a
   neighboring tool instead, and any surprising semantics (side effects,
   add-only behavior). Add `.describe()` on every zod field. English only.
3. **Reuse `src/core/`** — the handler should be parameter plumbing plus
   Markdown formatting. Reuse `filterShape` / `hitsToMarkdown` where they
   fit.
4. Wrap the body in `try/catch` returning `errorResult(e)`; return via
   `text(markdown)`.
5. Extend `tests/mcp.test.ts`: update the expected tool-name list (the
   10-tool assertion will fail until you do — by design) and add a call test
   through the in-memory client.
6. Update this document and, if the tool changes user-facing behavior, the
   READMEs.

## Deviations from SPEC

- **No idle background embedding backfill** while `kura mcp` runs. SPEC
  §5.3(3) planned idle backfill in the resident servers; instead
  `kura_query` relies on the pre-search auto-backfill (≤ 100 pending chunks)
  inside the hybrid pipeline and otherwise warns and points to `kura embed`.
- **`key` inputs accept full paths and titles too** (`kura_get` /
  `kura_update` / `kura_related`): SPEC §9's table implies doc_keys only;
  `resolveDoc()` extends this to the computed full path and unique titles,
  with an explicit ambiguity error.
- **`path` params on `kura_add` / `kura_update` are additions** —
  hierarchical document paths post-date SPEC §9.
- **`limit` is capped at 50** by the zod schema (200 for `kura_changes`)
  and defaults differ per tool (`kura_query`: config `default_limit`;
  `kura_search`: 10) — SPEC leaves these unspecified.
- `kura_list_tags` output is a flat `path (count)` list; SPEC just says
  "list tags" (the tree rendering exists only in the CLI and browser UI).

## Related docs

- [http-api.md](http-api.md) — the human-facing counterpart, same core reuse
  rules
- [search-pipeline.md](search-pipeline.md) — what `kura_query` /
  `kura_search` actually run
- [llm-providers.md](llm-providers.md) — provider detection and the test
  override
- [testing.md](testing.md) — mock-provider policy, Japanese fixtures
