# Testing

> Covers SPEC §14. Key sources: `tests/*.test.ts`, `tests/fixtures/docs/`,
> `src/core/llm/provider.ts` (`setProviderForTests`), `src/core/config.ts`
> (`resetConfigCache`), `src/core/db.ts` (`closeDb`, `openDatabase`),
> `.github/workflows/ci.yml`.

`bun test` runs everything; CI (`.github/workflows/ci.yml`) runs
`bun run check` + `bun test` with `KURA_TEST_DOWNLOAD=1` on a pinned Bun
version. Tests must **never** touch the real `~/.kura` — every test either
opens `:memory:` directly or fabricates a `KURA_HOME` under a temp dir.

## Test map

| File | Layer | Verifies |
| --- | --- | --- |
| `tests/cli.test.ts` | e2e | Dispatcher: `--version`, `--help`, no-args help, unknown command → 2, invalid option → 2 + usage on stderr. |
| `tests/init.test.ts` | e2e | `init --no-download` creates config + DB (trigram), idempotent rerun; pre-init `doctor` suggests `kura init`. |
| `tests/db.test.ts` | unit + gated integration | Migration v1 table set, default bucket, meta seeding, reopen idempotence, `vec0` KNN with custom dimensions, trigram FTS on Japanese, FK enforcement, `getDb` init hint and `:memory:` bypass; the `KURA_TEST_DOWNLOAD` vaporetto download/load test. |
| `tests/config.test.ts` | unit | Defaults match SPEC §11, TOML serialize/parse round-trip, merge-onto-defaults, unknown-key/type-mismatch tolerance, dotted get/set typing, flat listing. |
| `tests/documents.test.ts` | unit | Repository invariants: derived-table sync, link auto-resolution (case-insensitive, bucket-scoped), duplicate full-path rules, chunk rebuild only on content change, rename relinking, delete cleanup, `resolveDoc` ambiguity, `touchAccess`, list filters, import/export round-trip (incl. the numeric doc_key regression and the favorite flag: an absent frontmatter key leaves the pin alone, an explicit `false` clears it), `setFavorite` leaving `updated_at` alone, tag/link/bucket core functions. |
| `tests/paths.test.ts` | unit | Document paths: `normalizeDocPath` / `joinDocPath` / `replaceWikiLinkTargets`, per-path uniqueness (incl. cross-form full-path collisions), two-stage link resolution (ambiguity, stickiness, doctor bulk pass), `resolveDoc` full-path/ambiguity messages, rename/move rewrite matrix, `moveDocumentsByPrefix` rollback + guards, `createDocumentWithRetry` suffixes, `prefix` list filter, import path fallback, `buildDocTree` / `docTree` (branch/leaf structure, merge, literal-`/` titles). |
| `tests/migration.test.ts` | unit | Schema v2 rebuild: v1-seeded data survives `migrate()` (ids/doc_keys/links/tags/chunks/FTS intact, `foreign_key_check` clean, indexes recreated, `path=''` backfill), and the new `UNIQUE(bucket_id, path, title)` semantics. Schema v3: `favorite` is added with existing rows defaulting to unpinned, plus the partial index. |
| `tests/filing.test.ts` | unit (mock provider) | Path-suggestion engine (`src/core/filing.ts`, now the `kura triage` path step): unfiled listing, structural link/tag voting with evidence, LLM pick (mocked, normalized, `isNew`), unusable-answer fallback, no-signal and no-provider degraded paths. |
| `tests/wiki.test.ts` | unit + property | `[[link]]` / `#tag` extraction: forms, trimming, dedup, code-block and inline-code exclusion, CRLF; property-based invariants over seeded random input (SPEC §14); extreme inputs. |
| `tests/chunker.test.ts` | unit | Chunk sizing around the 1600-char target, breakpoint scoring (headings, fences never split), overlap, `startOffset` consistency, context headers mapping to real headings. |
| `tests/render.test.ts` | unit | ANSI renderer: `color: false` purity, per-element decoration, no wrapping inside code blocks, fullwidth-aware wrapping, hanging indents; `isColorEnabled` × `NO_COLOR` × TTY matrix. |
| `tests/search.test.ts` | unit (mock provider) | Trigram keyword search (BM25 title weighting, `--all` AND, filters, <3-char LIKE fallback, query escaping), embedding backfill + KNN + per-doc aggregation, dimension-mismatch guidance, hybrid fusion/rerank/expand with `llm_cache` hit counting, degraded mode, `parseYesNo`, `blendScores` weights. |
| `tests/regression-search.test.ts` | regression (fixtures) | The 30-document Japanese corpus: load + FTS sync, BM25 ranking cases, `**` snippets and `…` elision, hierarchical tag filtering, AND-vs-OR cardinality, fixture cross-link backlinks, hybrid degraded mode, latency smoke (<300 ms). |
| `tests/m6.test.ts` | unit (mock provider) | Clip extract/format (readability, turndown fallback, LLM formatting + `clip` cache, tag suggestion + `tag` cache, script stripping), gardening (levenshtein, merge candidates, oversized tags, untagged docs), stale scoring, all `doctor` fixes incl. `chunks_vec` recreation and `retokenizeFts`. |
| `tests/commands-crud.test.ts` | e2e | `add` (frontmatter, stdin, `--title` rules), `get` (`--raw`/`--json`/`--lines`), `mv` relinking, `rm` non-TTY refusal + `--force`, `edit` via a scripted `EDITOR`, exit 3 for missing docs, `ls` filters/sorts/limits/JSON, path flags (`add --path` / `ls --prefix` / full-path `get` / `mv --path` / `mv --prefix`), `triage` (`--json` shape, `--apply`, provider-less degraded run). |
| `tests/commands-io.test.ts` | e2e | `import`/`export` round-trip across two homes (kura_key stability), filename sanitizing, `--tag` filtered export, path-to-directory export + frontmatter/dir-derived path import, invalid-frontmatter skip + all-skipped exit 1, `bucket` add/ls/mv/rm semantics. |
| `tests/commands-taglink.test.ts` | e2e | `tag ls/--tree/--json`, `tag add/rm/mv/gc` exact outputs, `link ls` three sections + JSON shape, `kura audit links` + auto-resolution on target creation. |
| `tests/api.test.ts` | integration | REST endpoints (SPEC §8.2) against `startServer` on port 0: stats, buckets, docs CRUD + pagination, `PUT` path moves (incl. the 409 on a collision) and `PUT /api/docs/:key/favorite` (pins without bumping `updated_at`, `?favorite=1` filter, 400 on a non-boolean body), related, three search modes + error cases, tags, graph, SPA fallback, 404 JSON. |
| `tests/mcp.test.ts` | integration | MCP server over `InMemoryTransport`: 10 tools with guidance text, search→get flow (access_count), degraded `kura_query`, add/update/list_tags, related, status, `isError` for unknown keys. |
| `tests/editor.test.ts` | unit | Inline block editor: Markdown ⇄ block-model round-trip is a fixed point on Japanese fixtures (parse → serialize). |
| `tests/client-build.test.ts` | build | `bun run build:client` produces `dist/`, and `startServer` serves it with SPA fallback. |

## Isolation patterns

Two tiers, matching the two ways kura opens a database:

- **In-process unit tests** call
  `openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 })`
  directly: no filesystem, vaporetto explicitly disabled (deterministic
  trigram everywhere), and 4-dimensional vectors so mock embeddings are
  cheap to write. Each test closes its own `db` in `afterEach`.
- **e2e tests** spawn the real CLI (see below) with
  `KURA_HOME=mkdtempSync(...)` and run `kura init --no-download` once per
  scenario home. Some suites also set `KURA_DB` explicitly so they can open
  the same file in-process for setup/verification
  (`tests/commands-taglink.test.ts`).

Shared hygiene:

- `resetConfigCache()` (`src/core/config.ts`) before **and** after any
  in-process test that changes `KURA_HOME`/config files — `loadConfig` is
  cached per process.
- `closeDb()` (`src/core/db.ts`) to discard the CLI's singleton connection
  when a test used `getDb()`.
- Env vars are backed up in `beforeEach` and restored (including
  *deleting* keys that were originally unset) in `afterEach`
  (`tests/db.test.ts` is the canonical example).
- Subprocess runs always inject `NO_COLOR: "1"` so output assertions never
  see ANSI escapes.
- Temp homes are `rmSync(..., { recursive: true, force: true })`-ed in
  `afterAll`/`afterEach`.

## CJK data policy (mandatory)

**Japanese search regression coverage is a hard requirement; English-only
search tests are not acceptable** (SPEC §14, restated in `CLAUDE.md`).
Translating fixtures or queries to English would silently gut the
tokenization/BM25/snippet regressions the suite exists to catch.

### The 30-document fixture corpus

`tests/fixtures/docs/01..30-*.md` model the three real-world genres from
SPEC §14, each with frontmatter (`title`, `tags`, `bucket: main`):

- `01–12` tech memos (`tech/...` tags) — SQLite, FTS, tokenizers,
  TypeScript, Bun, Docker, git, networking;
- `13–21` meeting minutes (`minutes/...` tags);
- `22–30` clipped articles (`clips/...` tags).

`tests/regression-search.test.ts` asserts the count is exactly 30 and loads
them through `parseFrontmatter` + `createDocument` (so the corpus also
exercises the real ingestion path, including `[[link]]` extraction).

**Verification terms are placed deliberately.** Each ranking case plants the
same word in one document's *title* and another document's *body only*
(e.g. トランザクション in `01-sqlite-transaction.md`'s title vs
`02-wal-mode.md`'s body) so BM25's 5.0/1.0/3.0 column weighting is
observable. Tag-filter cases rely on the genre taxonomy (the same query
全文検索 returns different, hand-counted result sets under `tag: minutes` /
`tech` / `clips`). Cross-links between fixtures (`[[全文検索エンジンの比較]]`
etc.) feed the backlink assertions. When you edit a fixture, check which
assertions count or rank it — several expectations are exact
(`or.length === 7`, exact title lists).

### The trigram 3-character constraint

The regression corpus runs on the **trigram** tokenizer (vaporetto is not
loadable in unit tests), which cannot match terms shorter than 3 characters.
Consequences for test-query design:

- Queries in trigram-backed tests must use terms of **3+ characters**
  (トランザクション, 形態素解析, 全文検索 …) — a 2-char query would
  legitimately return nothing and the test would be meaningless.
- The deliberate exception: `tests/search.test.ts` queries 猫 (1 char) to
  pin the `LIKE` fallback path in `src/core/search/keyword.ts`.
- Vaporetto-dependent behavior (morphological OR queries) is only exercised
  in the network-gated integration test below.

## Mock LLM provider pattern

`setProviderForTests` (`src/core/llm/provider.ts`) pins the provider
resolution globally: pass a mock to use it, `null` to simulate "no provider
reachable" (deterministic degraded mode — used by the regression, API, and
MCP suites), and `undefined` in `afterEach` to clear the override. It also
clears the 60 s detection cache.

The reference mock is `MockProvider` in `tests/search.test.ts`:

- **`embed`** returns deterministic 4-dim vectors keyed on keyword
  occurrence (猫→axis 0, 犬→axis 1, データベース→axis 2, else axis 3), so
  KNN ranking is predictable and dimension checks stay cheap.
- **`chat`** inspects the prompt to decide which feature is calling: a
  `<Query>: …` line means rerank (answer `yes` iff the `<Document>` block
  contains the first query term), otherwise it is query expansion and
  returns a fixed JSON array of variants.
- **`embedCalls` / `chatCalls` counters** make `llm_cache` verifiable: run
  the same query twice and assert the counter did not move (rerank cache),
  or assert exactly one `llm_cache` row exists for a purpose
  (`expand`, `clip`, `tag`).

`ClipMockProvider` in `tests/m6.test.ts` shows the second dispatch style:
sniffing the **system** prompt (contains タグ付け → return tag JSON;
otherwise return a `TITLE: …` formatted-clip response), and embedding
vectors that make db/database tags cosine-similar for the gardening audit.
Real network providers are never contacted in tests; live connectivity is
`kura doctor`'s job (SPEC §14).

## e2e pattern

All command-level suites share the same `runCli` helper: spawn
`bun run src/cli/index.ts <args>` with
`{ ...process.env, NO_COLOR: "1", ...env }`, capture stdout/stderr/exit code
via `Promise.all`. Conventions on top:

- **Setup**: `mkdtempSync` a home, `runCli(["init", "--no-download"], env)`,
  assert exit 0 before the scenario starts.
- **Doc keys** are recovered from human output with `/#([0-9a-f]{8})/`
  (`keyOf`) and validated in JSON with a `^[0-9a-f]{8}$` matcher.
- **stdin**: `runCli(["add", "-", ...], env, "本文…")` pipes a buffer.
- **`EDITOR` substitution**: `tests/commands-crud.test.ts` writes a small
  Bun script that rewrites the temp file, then runs
  `kura edit` with `EDITOR: "bun ${script}"` — this exercises the whole
  frontmatter round-trip and the "no changes" path without a TTY.
- **Interactive prompts are tested via their non-TTY behavior** (e.g. `rm`
  without `--force` exits 2); there is no PTY harness.
- `tests/commands-taglink.test.ts` adds a resilience trick: a `beforeAll`
  probe detects whether `add`, `import`, or only the in-process repository
  is usable for seeding (`detectAddMode`) — written while those commands
  were developed in parallel, and a useful pattern when a suite needs
  seeding but must not depend on an unrelated command's health.

## Network-gated integration test

`tests/db.test.ts` ends with a `test.skipIf(!process.env.KURA_TEST_DOWNLOAD)`
block that performs the real thing: download the pinned sqlite-vaporetto
release from GitHub (`ensureVaporetto`, SHA256-verified), load the native
extension, build a vaporetto FTS table, and tokenize Japanese through
`vaporetto_or_query`, under a 120 s timeout. It is opt-in because it hits
the network and executes downloaded native code. CI enables it
(`KURA_TEST_DOWNLOAD: "1"` in `.github/workflows/ci.yml`, linux-x64);
locally run `KURA_TEST_DOWNLOAD=1 bun test tests/db.test.ts`. This is the
only test allowed to touch the network besides loopback servers
(`tests/m6.test.ts` and `tests/api.test.ts` spin up `Bun.serve` on
`127.0.0.1`).

## Lessons learned

### The all-digit doc_key YAML flake (~2.3% per key)

Doc keys are 8 hex chars. With probability `(10/16)^8 ≈ 0.023`, a generated
key contains **only digits** (`16052989`), and YAML parses an unquoted
`kura_key: 16052989` as a *number* — so export→import round-trips (and
`kura edit`, which compares the frontmatter key against the document key)
would randomly fail for ~2.3% of documents, i.e. a flaky test roughly once
per ~40 generated keys. Keys like `12e45678` are worse: YAML reads them as
floats in exponent notation, mangling them irreversibly. The fix is
three-layered (all still in place — don't remove any layer):

1. `serializeFrontmatter` **always quotes** `kura_key`
   (`src/core/frontmatter.ts`), so everything kura itself exports is safe;
2. `parseFrontmatter` rescues hand-written unquoted numeric keys
   (`typeof rawKey === "number"` → `String(rawKey)`), covering all-digit
   keys from external files;
3. `kura edit` re-scans the raw frontmatter text with a regex
   (`rawFrontmatterKey` in `src/cli/commands/edit.ts`) before rejecting a
   "changed" key, covering keys YAML has already coerced.

The regression test (`tests/documents.test.ts`, "all-digit and
exponent-like doc_keys round-trip") pins `16052989`, `12e45678`, and
`0012ab34` explicitly. The general lesson: **when a value is generated from
randomness, enumerate the pathological shapes and pin them as fixed test
inputs** — probabilistic flakes at 2% per artifact are near-certain across a
CI month but almost never reproduce on a developer's first rerun.

### Assert the skip/stderr diagnostics first

Commands that skip items (`kura import`) report the reason on **stderr**
while the summary goes to stdout. `tests/commands-io.test.ts` asserts
`expect(result.stderr).toBe("")` *before* checking the exit code or counts:
when the test breaks, the failure message then *contains the reason*
("skip …: invalid frontmatter …") instead of an opaque
`expected "3 created" got "2 created"`. Apply the same ordering to any test
whose subject can partially succeed — assert the diagnostic channel first,
the aggregate result second.

## Adding tests for a new feature

Work down the same layers the feature touches:

1. **Core logic** → a unit test on `:memory:`
   (`openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 })`)
   in the matching file (`documents`, `search`, `m6` for
   clip/gardening/doctor, or a new `<topic>.test.ts`). Use Japanese titles,
   bodies, tags, and queries; respect the 3-char trigram rule.
2. **LLM-dependent behavior** → extend a mock provider (or add one) wired
   via `setProviderForTests`; make it deterministic, count calls if the
   feature caches, and add a `setProviderForTests(null)` case proving the
   degraded path (degradation is a hard product requirement).
3. **CLI surface** → an e2e case with `runCli` in the appropriate
   `commands-*.test.ts`: happy path, `--json` shape, and each failure exit
   code (2/3/4) the command can produce.
4. **Search-relevant changes** → extend `tests/regression-search.test.ts`
   and, if new fixture text is needed, keep the corpus at exactly 30 files
   or update `FIXTURE_COUNT` deliberately; re-verify the exact-count
   assertions your text may now match.
5. **Parsers / scoring primitives** → add property-based or boundary tests
   in the style of `tests/wiki.test.ts` (seeded PRNG over a piece alphabet,
   invariants instead of golden output).
6. **HTTP / MCP surface** → mirror the CLI behavior in `tests/api.test.ts`
   / `tests/mcp.test.ts`; both stacks must reuse `src/core/` so a
   divergence usually means logic leaked into a handler.

Update the table in this document when you add a test file, and keep the doc
in sync with behavior changes (`.claude/docs/README.md` convention).

## Deviations from SPEC

- **Property-based tests cover the wiki parser only.** SPEC §14 asks for
  property-based boundary tests for "the chunker, the wiki parser, and RRF";
  `tests/chunker.test.ts` uses generated-but-deterministic boundary
  fixtures (long prose, fence-heavy memos) rather than randomized
  properties, and RRF/blending is covered by exact unit cases
  (`blendScores`) with no property harness.
- **The e2e "main flow" is split across suites** (`init` →
  `commands-crud` → `regression-search` → `commands-io`) instead of a single
  init→add→search→query→export→import scenario; `query` specifically is
  exercised in-process (mock provider) rather than as a subprocess.
- **Real-provider integration is delegated entirely to `kura doctor`**
  (as SPEC allows); no test, gated or not, talks to Ollama/LM Studio.
