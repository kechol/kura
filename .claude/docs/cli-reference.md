# CLI reference

> Covers SPEC §7. Key sources: `src/cli/index.ts`, `src/cli/args.ts`,
> `src/cli/render.ts`, `src/cli/searchOutput.ts`, `src/cli/commands/*.ts`,
> `src/core/errors.ts`, `src/core/documents.ts` (`resolveDoc`).

Every command lives in its own file under `src/cli/commands/` and is
registered in `src/cli/index.ts` with a lazy `import()` (startup-cost
control). A command module exports `summary`, `usage`, and
`run(argv) → exit code`. `kura --help` / `kura help` / no arguments print the
command list; `kura --version` / `-v` / `version` print the version from
`package.json` (`src/core/paths.ts`). `kura <cmd> --help` prints the module's
`usage` string and exits 0. Unknown commands exit 2.

## Global conventions

### Argument parsing

`parseCommandArgs` (`src/cli/args.ts`) wraps Node's `util.parseArgs` in
strict mode and merges `--json` and `--help`/`-h` into **every** command's
option set. Unknown options or malformed values become `UsageError` (exit 2,
usage printed to stderr). Helpers: `strOpt`, `boolOpt`, `intOpt` (throws
`UsageError` on non-integers), `listOpt` (comma-separated, trimmed,
empties dropped).

### Document specifier `<doc>`

Resolved by `resolveDoc` in `src/core/documents.ts`, in this order:

1. `#a1b2c3d4` — explicit key. Must match `/^[0-9a-f]{8}$/` (else
   `UsageError`); missing key is `NotFoundError` (exit 3).
2. Bare `a1b2c3d4` — if it looks like a key, tried as a key first; on a miss
   it falls through (so an 8-hex-char *title* still works).
3. Full path (e.g. `clips/Title`), matched case-insensitively against the
   computed full path (`path === '' ? title : path + '/' + title`). Unique
   per bucket, so multiple matches mean multiple buckets → `ConflictError`
   suggesting `#key` or `--bucket`.
4. Title, matched case-insensitively. With `--bucket` the lookup is scoped to
   that bucket; without it the lookup spans **all buckets**. A title carried
   by more than one document — possible even inside one bucket now, under
   different paths — throws `ConflictError` (exit 1) listing
   `#key (bucket, path/)` candidates and suggesting `#key`, the full path,
   or `--bucket`.
5. Alias, matched case-insensitively against `document_aliases` with the
   same `--bucket` scoping. Exactly one owning document resolves; several →
   `ConflictError`; none → `NotFoundError` (exit 3). See
   [document-notation.md](document-notation.md).

### `--bucket` defaults

There is no single global default; each command class behaves differently:

| Commands | `--bucket` omitted means |
| --- | --- |
| `add`, `clip`, `import` (write target) | `general.default_bucket` from config (frontmatter `bucket:` wins over the default for `add`/`import`) |
| `get`, `edit`, `rm`, `mv`, `tag add/rm`, `link ls`, `alias`, `history` (title resolution) | all buckets, ambiguity is an error |
| `mv --prefix` (bulk path move), `triage` (default backlog scope) | `general.default_bucket` |
| `ls`, `search`, `vsearch`, `query`, `ask`, `changes`, `audit`, `export` (filters) | all buckets |

### Exit codes

Defined in `src/cli/args.ts` (`EXIT`) and mapped from exception types in
`src/cli/index.ts::main`. Commands either return a code or throw; the
dispatcher does the translation.

| Code | Constant | Produced by | Notes |
| --- | --- | --- | --- |
| 0 | `OK` | normal completion | also: `rm`/`clip` confirmation answered "no" ("aborted") |
| 1 | `ERROR` | any `Error` not listed below, incl. `ConflictError` | duplicate titles, ambiguous titles, non-empty bucket `rm`, `doctor` with failed checks, `import` where every file was skipped, non-TTY `clip` URL duplicate without `--force` |
| 2 | `USAGE` | `UsageError` | bad flags/positionals; also prints the command's `usage` to stderr. Unknown command names too |
| 3 | `NOT_FOUND` | `NotFoundError` | missing document / bucket / config key |
| 4 | `NO_LLM` | `LLMUnavailableError` | thrown by `requireProvider` (`src/core/llm/provider.ts`); dispatcher appends a "Run 'kura doctor'" hint |

Exception classes live in `src/core/errors.ts` and are re-exported through
`src/cli/args.ts`. Only `vsearch`, `embed`, and `audit contradictions` call
`requireProvider` and can exit 4; `query`, `ask`, `clip`, `triage`, and the
other `audit` subcommands use `resolveProvider` and degrade with warnings
instead (SPEC §5.1 degraded mode).

### `--json`

Accepted by every command (parser-level), but only read commands and the
bulk I/O commands honor it: `status`, `config list/get`, `add`, `get`, `ls`,
`export`, `import`, `bucket ls`, `tag ls`, `link ls`, `alias ls`,
`history`, `changes`, `audit`, `triage`, `search`, `vsearch`, `query`, `ask`. Write commands like `rm`, `mv`, `edit`
silently ignore it. JSON goes to stdout; warnings and progress always go to stderr, so
`--json` output stays parseable when piped.

### TTY and ANSI rendering

`src/cli/render.ts` implements the in-house Markdown → ANSI renderer
(headings, emphasis, inline/fenced code, lists, quotes, rules, wiki links,
tables pass through; wraps at width 80 counting East-Asian fullwidth
characters as width 2). Rules:

- `isColorEnabled()`: color only when the stream is a TTY **and** `NO_COLOR`
  is unset or empty. `NO_COLOR` disables ANSI escapes, not the layout.
- `kura get` renders pretty output when stdout is a TTY (or `--pretty` is
  forced) and emits the raw body when piped (or `--raw`).
- Search results, `ls`, `status`, etc. print plain line-oriented text
  regardless of TTY; only `get` and `ask` (the generated answer) use the
  renderer.
- Interactive confirmations (`rm`, `clip`, `triage` per-step prompts,
  `audit dupes/tags --apply`) require both stdin and stdout to be TTYs; see
  the individual commands for their non-TTY behavior.

---

## Setup and diagnostics

### `kura init`

```
kura init [--no-download]
```

Idempotent bootstrap (`src/cli/commands/init.ts`): creates `KURA_HOME` and
`lib/<version>/`, writes a default `config.toml` if absent ("exists, kept"
otherwise), downloads/extracts sqlite-vaporetto when the platform is
supported (`src/core/bootstrap.ts`; SHA256-pinned), opens/creates the DB
(which picks the FTS tokenizer and runs migrations, `src/core/db.ts`), then
prints `ollama pull` lines for the three configured models plus a
`kura doctor` pointer. `--no-download` skips the vaporetto fetch and the DB
is created with the trigram tokenizer — the standard way tests build an
isolated home. A failed download is a **warning**, not an error: FTS falls
back to trigram and `init` still exits 0.

### `kura doctor`

```
kura doctor [--fix]
```

`src/cli/commands/doctor.ts` prints one `✓ / ⚠ / ✗` line per check and a
summary; exits 1 only when at least one check **failed** (warnings don't
affect the exit code). Checks: platform/Bun/KURA_HOME, Homebrew SQLite
(macOS only, fail when missing), config parse, sqlite-vec load
(`vec_version()` probe), vaporetto load + a live Japanese tokenization probe,
database (`PRAGMA quick_check`, schema version, doc count,
documents/FTS row-count sync, tokenizer-vs-availability mismatch, meta
`embedding_model` vs config), Ollama reachability + required models
(suggests `ollama pull …`), LM Studio reachability, and the resolved
provider (warn on `none`: degraded mode).

`--fix` runs **before** the checks (`runFixes`), in this order
(`src/core/doctor.ts`):

1. download vaporetto if supported and missing,
2. `recreateVecIfModelChanged` — meta vs config mismatch drops and recreates
   `chunks_vec` with the new dimensions and NULLs all `embedded_at`
   (follow up with `kura embed`),
3. `gcOrphans` — orphaned `chunks` / `chunks_vec` rows,
4. `fixContentHashes` — recompute mismatched hashes and re-chunk (preserves
   `updated_at`),
5. `rebuildFtsIfNeeded` — row-count mismatch triggers a full FTS reinsert,
6. `resolveAllUnresolvedLinks` — bulk re-resolution through the shared
   two-stage resolution (same bucket, case-insensitive, full path then
   title; ambiguous short-form references are skipped),
7. `retokenizeFts` to vaporetto when the DB was built with trigram but
   vaporetto now loads.

### `kura status`

```
kura status [--json]
```

Statistics from `src/core/stats.ts` plus the top-5 stale documents from
`src/core/stale.ts`: total documents and per-bucket counts, tag count,
embedding coverage (`embedded/total chunks` + meta model), stale count with
per-doc score lines, a **Backlog** line
(`backlog: N documents (X unfiled, Y untagged)`, followed by a
`run 'kura triage' to organize` pointer when the backlog is non-empty),
unresolved link count, DB size and active tokenizer. `--json` prints the
stats object with a `staleTop` array added; the object additionally carries
the additive `unfiled`, `untagged`, and `triageBacklog` counts (the same
`collectStats` fields flow through `GET /api/stats`, see
[http-api.md](http-api.md)).

### `kura config`

```
kura config list [--json] | get <key> | set <key> <value>
```

Dot-notation access to `~/.kura/config.toml`; the subcommand defaults to
`list`. Unknown keys are `NotFoundError` (exit 3); `set` preserves the
existing value's type. Full semantics in
[configuration.md](configuration.md).

---

## Document CRUD

### `kura add`

```
kura add <file>... [--bucket b] [--path p] [--tags t1,t2] [--title T] [--type markdown|html] [--json]
kura add - --title T
```

Creates one document per input file (`src/cli/commands/add.ts` →
`createDocument`). Frontmatter is parsed and honored
(`src/core/frontmatter.ts`); a `kura_key` in frontmatter is **ignored with a
warning** pointing at `kura import` (add always creates). Rules:

- **Title precedence: frontmatter `title:` → `--title` → file basename**
  (extension stripped). `--title` with multiple files is a usage error;
  stdin (`-`) requires `--title` (there is no basename fallback).
- `--tags`, when given, **replaces** frontmatter tags entirely (an empty
  `--tags ""` clears them); hashtags in the body are still extracted and
  merged by the repository layer.
- `--type` overrides frontmatter `content_type`; values other than
  `markdown`/`html` are usage errors.
- Bucket: `--bucket` → frontmatter `bucket:` → `general.default_bucket`. The
  bucket must already exist (`NotFoundError` otherwise — unlike `import`,
  which auto-creates).
- **Path precedence: `--path` → frontmatter `path:` → bucket root** (`''`).
  The value is normalized (`normalizeDocPath`).
- The single blank separator line after the frontmatter block is stripped
  from the body.
- A duplicate computed full path in the bucket (case-insensitive) →
  `ConflictError` (exit 1).

Output: `#key  path/title  (bucket)` per document; `--json` prints an array
of `{key, path, title, bucket, tags, created_at}`. Embeddings are **not**
generated (lazy backfill, see [`embed`](#kura-embed)).

### `kura get`

```
kura get <doc> [--pretty|--raw] [--json] [--lines A:B] [--bucket b] [--as-of T]
```

Resolves the document, calls `touchAccess` (increments `access_count`, sets
`last_accessed_at`), then re-reads so the output reflects post-touch values.
`--lines A:B` slices 1-based inclusive line ranges; open ends `50:` and
`:100` are allowed, `":"` alone or inverted ranges are usage errors.
Output modes: `--json` → full record
(`key, path, title, bucket, tags, aliases, content, content_type,
source_url, created_at, updated_at, last_accessed_at, access_count`;
`content` is the sliced text); otherwise pretty ANSI (TTY default, or
`--pretty`) with a synthesized `# title` heading and a
`#key · bucket · path · tags · aliases: …` meta line (empty parts omitted),
or the raw body (piped default, or `--raw`). `--pretty --raw` together is a
usage error.

`--as-of <time>` (ISO 8601 or `YYYY-MM-DD`, anything `Date`-parsable —
`toSqliteDatetime`; unparsable is a usage error) shows the document **as it
was at that time**: the newest state — current row or revision — whose
`saved_at` is `<= time` (`stateAsOf` in `src/core/revisions.ts`; see
[data-model.md](data-model.md) `document_revisions` and `kura history`).
The historical title, path, and body are swapped into the output;
**tags and aliases shown remain the current ones** (they are not
versioned). No recorded state that old (document created later, or the
snapshot pruned) → `NotFoundError` (exit 3). `--json` additionally carries
`as_of` (normalized SQLite datetime) and `revision_id` (`null` when the
current state answered). The pretty meta line gains
`as of <time> (rN)`.

### `kura edit`

```
kura edit <doc> [--bucket b]
```

Round-trips **frontmatter + body** through an editor
(`src/cli/commands/edit.ts`): serializes
`kura_key/title/bucket/path/tags/source_url/content_type/created_at/updated_at`
above the body into `$TMPDIR/kura-edit-<key>-<pid>-<ts>.md`, launches the
editor, and re-parses on exit.

- **Editor resolution: `general.editor` (config) → `$EDITOR` → `vi`.** The
  value is split on whitespace, so `EDITOR="bun script.ts"` works.
- Non-zero editor exit discards changes (temp file kept, exit 1). A
  byte-identical file prints `no changes`.
- Frontmatter edits are applied: title changes rename (and relink referrers,
  same as `mv`), `path:` moves the document within the bucket (the line is
  omitted for root documents; **deleting the `path:` line moves the document
  to the bucket root**), `bucket:` moves the document, and the frontmatter
  `tags` list is authoritative — tags removed from the list are detached via
  `removeTagsFromDoc`, new ones attached.
- **`favorite` is not part of the edit buffer** (unlike `kura export`, which
  writes it): favorites are a browser affordance, and an editor round-trip
  must not be able to drop one by accident.
- `kura_key` must not change; a mismatch aborts with a usage error and keeps
  the temp file. Because YAML would coerce an unquoted all-digit key to a
  number, the raw text is re-scanned (`rawFrontmatterKey`) before rejecting —
  see [testing.md](testing.md#lessons-learned) for the incident.

### `kura rm`

```
kura rm <doc> [--force|-f] [--bucket b]
```

Interactive `[y/N]` confirmation on a TTY; anything but `y`/`yes` prints
`aborted` (exit 0). **Without `--force` on a non-TTY it refuses with a usage
error (exit 2)** — scripts must pass `--force`. Deletion cleans FTS and
`chunks_vec` explicitly and relies on CASCADE / SET NULL for the rest;
incoming links revert to unresolved (they re-resolve if a document with the
same title is created later, SPEC §10.1).

### `kura mv`

```
kura mv <doc> [<new-title>] [--path <new-path>] [--bucket b]
kura mv --prefix <old-prefix> <new-prefix> [--bucket b]
```

Renames and/or moves via `updateDocument` (`src/core/documents.ts`); at
least one of `<new-title>` / `--path` is required (`--path ''` moves to the
bucket root). Same-bucket referrer bodies (and self-links) are rewritten per
the rename/move matrix
([document-notation.md](document-notation.md#unresolved-links-and-rename-rewriting)):
a **title change** rewrites both `[[old title]]` and `[[old/full/path]]`
(the short form is repointed at the new full path when the new title alone
would be ambiguous); a **path-only move** rewrites only the full-path
spelling, so short `[[title]]` links stay valid. Prints
`renamed|moved #key  old/full/path -> new/full/path  (relinked N documents)`
("moved" whenever `--path` was given). A destination whose computed full
path already exists in the bucket (case-insensitively) is a
`ConflictError`. Unresolved links that already pointed at the *new* title or
full path are auto-resolved. Chunks are rebuilt on rename (chunk context
headers embed the title).

`--prefix` moves **every document under a path prefix** at once
(`moveDocumentsByPrefix`, mirroring `kura tag mv`), scoped to `--bucket` or
`general.default_bucket`. Unlike tag renames there is **no merge**: a
destination conflict throws `ConflictError` and rolls back the whole move.
Guards: an empty old prefix is a usage error; identical prefixes or moving a
prefix under its own descendant are conflicts; no documents under the prefix
is `NotFoundError` (exit 3). Prints one `moved #key  from -> to` line per
document plus an `N documents moved (relinked M documents)` trailer.

The `mv suggest` filing assistant that once lived here is now the **path
step** of [`kura triage`](#kura-triage) (`src/core/filing.ts`): it proposes a
document path for unfiled documents (bucket root, `path = ''`) from the same
structural / semantic / LLM signal layers, cached in `llm_cache` under
purpose `path`. `kura mv` itself no longer has a `suggest` subcommand, nor
the `--apply` / `--limit` flags it carried.

### `kura ls`

```
kura ls [--bucket b] [--tag t] [--prefix p] [--sort updated|created|accessed|title|views] [--stale] [--limit n] [--json]
```

`listDocuments` with filters; `--tag` includes descendant tags
(`t` matches `t` and `t/…`); `--prefix` filters by document path,
descendants included (`p` matches path `p` and `p/…`, case-insensitively) —
the value is normalized and must not be empty (usage error). Default sort is
`updated` (desc); `accessed`
puts never-accessed docs last; `views` orders by `access_count` (most-viewed
first, ties broken by most-recently accessed); invalid sorts are usage
errors. `--stale`
switches to staleness mode: candidates older than `general.stale_days` are
scored by `src/core/stale.ts` (age normalized by `stale_days`, dampened by
`access_count` and backlinks; only scores ≥ 1 qualify) and sorted by score
descending; `--limit` is applied **after** scoring. Text output is
`#key  path/title  [bucket]  tags  updated_at` plus an `N documents`
trailer; `--json` mirrors the `add`/`get` field names (including `path`).

### `kura export`

```
kura export [--bucket b] [--tag t] --dir <path> [--json]
```

Writes every matching document to `<dir>/<bucket>/<path…>/<title>.md` with
a serialized frontmatter block (`kura_key` always quoted; `path` emitted
when non-root; `aliases: [...]` emitted only when non-empty;
`favorite: true` emitted only for pinned documents;
datetimes emitted as ISO 8601). Document path segments become
real subdirectories; each segment and the title are sanitized independently
(`/ \ : * ? " < > |` and control chars → `-`) — a literal `/` in a *title*
becomes `-`, it never nests. Empty results use the key, and case-insensitive
collisions on the full nested relative path (`bucket/path…/name`) get a
`-<key>` suffix. Doubles as a backup; `--dir` is required. `--json` →
`{exported, dir}`.

### `kura import`

```
kura import <dir|file>... [--bucket b] [--json]
```

Directories are scanned recursively for `*.md` / `*.markdown` (name-sorted).
Per file: frontmatter with a `kura_key` that exists → **update** that
document; otherwise **create** (reusing the frontmatter key if it is unused
and well-formed). `--bucket` overrides frontmatter, which overrides
`general.default_bucket`; unlike `add`, missing buckets are **created**
(`getOrCreateBucket`). A document's path is frontmatter `path:` when
present, otherwise the file's subdirectory relative to the scanned root —
with the leading segment stripped when it equals the target bucket name, so
a `kura export` tree (`<dir>/<bucket>/<path…>`) round-trips; direct file
arguments import to the bucket root. Frontmatter `created_at`/`updated_at`
are preserved on round-trip, `aliases:` is applied add-only (invalid
entries dropped), and `favorite:` is applied when present (`true`
pins, `false` unpins); an absent key leaves the stored flag alone, so
importing an unpinned export never unstars anything. Invalid frontmatter or title conflicts (`ConflictError`) are
skipped with a `skip <path>: reason` line on stderr and the run continues.
Summary `imported: X created, Y updated, Z skipped`; `--json` →
`{created, updated, skipped: [paths]}`. Exit 0 if anything succeeded, **1
when every file failed**, 3 when a path doesn't exist or no Markdown was
found.

---

## Search

Search output is shared (`src/cli/searchOutput.ts`):
`#key  title  [bucket]  tags  (score)` plus an indented one-line snippet;
`no results` when empty. `--json` → array of
`{key, title, bucket, tags, score, snippet, source}` with the score rounded
to 4 decimals; `source` is `keyword` / `vector` / `hybrid`. The query is all
positionals joined with spaces; an empty query is a usage error.

### `kura search`

```
kura search "<query>" [--bucket b] [--tag t] [--all] [--limit 20] [--json]
```

Pure FTS5 BM25 (`src/core/search/keyword.ts`), no LLM. Title/content/tags/
aliases are weighted 5.0/1.0/3.0/5.0. With vaporetto, the input goes through
`vaporetto_or_query()` (or `vaporetto_and_query()` with `--all`); with
trigram, each whitespace-separated term is phrase-quoted and joined with
OR/AND. Trigram cannot match terms shorter than 3 chars: when such a term
exists and FTS returned nothing, a `LIKE`-based fallback runs (ordered by
`updated_at`, hand-built `**term**` snippets, score 0). A missing vaporetto
function surfaces as an error pointing at `kura doctor`.

### `kura vsearch`

```
kura vsearch "<query>" [--bucket b] [--tag t] [--limit 20] [--json]
```

KNN over `chunks_vec` (`src/core/search/vector.ts`). Requires an embedding
provider — exits 4 without one. Before searching, `ensureEmbeddings` checks
the backlog of `embedded_at IS NULL` chunks: **≤ 100 pending are backfilled
synchronously and silently; more than 100 prints a stderr warning and
searches anyway** with existing embeddings (run `kura embed` to catch up).
Results are aggregated per document keeping the best chunk; score is
`1/(1+distance)`; snippets are the chunk body with the context header
stripped. KNN fetches `max(limit*4, 40)` chunks so post-filtering by
bucket/tag still fills the limit.

### `kura query`

```
kura query "<query>" [--bucket b] [--tag t] [--expand] [--limit 10] [--json]
```

The hybrid pipeline (`src/core/search/hybrid.ts`, SPEC §5.1): optional LLM
query expansion (original weight 2, two variants weight 1, cached in
`llm_cache`) → keyword + vector candidate lists (top 50 each) → RRF fusion
(`rrf_k`, `keyword_weight`, `vector_weight` from config) → yes/no LLM rerank
of the top `rerank_top_k` → position-weighted blend (RRF ranks 1–3: 75/25,
4–10: 60/40, 11+: 40/60). Default limit is `search.default_limit`.

`query` **never exits 4**: without a provider it answers from keyword search
alone; failed vector search, expansion, or rerank each degrade independently
with a stderr `warning:` line. The auto-backfill rule from `vsearch` also
applies here.

### `kura ask`

```
kura ask "<question>" [--bucket b] [--tag t] [--expand] [--limit 10] [--json]
```

Answer generation on top of the hybrid pipeline (`askQuestion` in
`src/core/search/ask.ts`, [search-pipeline.md](search-pipeline.md)): the
question runs through `hybridQuery` (same options as `kura query`, including
`--expand`), the top 5 hits become numbered sources (first 1,600 body chars
each), and the generation model answers strictly from them, citing `[1]`,
`[2]`, … Answers are cached in `llm_cache` (purpose `ask`) keyed on the
question plus each source's `content_hash`, so editing a source invalidates
the cache. The question is all positionals joined with spaces; an empty
question is a usage error (exit 2).

Output does **not** use the shared search format: on a TTY the answer is
ANSI-rendered Markdown followed by a `sources:` list of
`[n] #key full/path/Title [bucket]` lines; piped, the raw answer text.
`--json` →
`{answer, sources: [{n, key, path, title, bucket}], hits: [{key, title, bucket}]}`
where `answer` is `null` in degraded mode and `hits` are the hybrid hits
beyond the cited sources.

`ask` **never exits 4**: with no provider, a generation failure, or zero
hits, it prints a stderr `warning:` and falls back to the plain `kura query`
hit list (exit 0). All hybrid warnings pass through unchanged.

### `kura embed`

```
kura embed [--all]
```

Backfills all pending chunks in batches of 16 (`backfillEmbeddings`),
resumable because `embedded_at` is set per chunk inside a per-batch
transaction. Progress goes to stderr: an in-place `\rembedding done/total`
line on a TTY, one line every 160 chunks otherwise. `--all` wipes
`chunks_vec` and re-embeds everything (the recovery step after changing the
embedding model/dimensions). When there is nothing to do and `--all` was not
given, prints "all chunks are already embedded" **without touching the
provider** (exit 0 even offline); otherwise a missing provider exits 4. A
returned vector whose length differs from `embedding_dimensions` aborts
with guidance. On success the meta keys `embedding_model` /
`embedding_dimensions` are updated to match config — this is what `doctor`
later compares (see [configuration.md](configuration.md#config-vs-meta)).

---

## Tags, links, buckets

### `kura tag`

```
kura tag ls [--tree] [--json]
kura tag add <doc> <tag>... [--bucket b]
kura tag rm <doc> <tag>... [--bucket b]
kura tag mv <old-path> <new-path>
kura tag gc
```

`src/cli/commands/tag.ts`, backed by `src/core/tags.ts` and
`src/core/gardening.ts`. Tag paths are normalized on entry (lowercased,
slashes trimmed/collapsed — `src/core/wiki.ts::normalizeTagPath`).

- `ls`: `path  count` lines in path order; `--tree` renders the hierarchy
  with cumulative counts (`segment (total)`), including intermediate nodes
  that have no documents of their own. `--json` returns `[{path, count}]`,
  or the `TagTreeNode[]` structure
  (`{segment, path, count, total, children}`) with `--tree`.
- `add` / `rm`: report exactly what changed (`added: …` / `no tags added`,
  `removed N tags`); attaching is idempotent, `rm` only counts tags that
  were present. `tag add` records `source='manual'`.
- `mv`: renames a tag **and all descendants**; when the target path already
  exists the documents are merged onto it (`moved N tags (merged into
  existing)`).
- `gc`: deletes tags attached to zero documents and lists them.

The tag-gardening subcommands moved into the [`kura audit`](#kura-audit)
umbrella: LLM tag **suggestion** is now the tags step of
[`kura triage`](#kura-triage) (`suggestTagsForText`, `src/core/tagging.ts`),
and the tag **audit** (merge candidates + oversized tags) is now
`kura audit tags` (below). `kura tag` no longer has `suggest` / `audit`
subcommands, nor the `--doc` / `--untagged` / `--apply` flags they carried.

### `kura link`

```
kura link ls <doc> [--bucket b] [--json]
```

`ls` prints three sections — `outlinks:` (each `[[target]] -> #key (bucket)`
or `(unresolved)`), `backlinks:`, and `2-hop (via <title>):` groups
(documents sharing an outlink target, `src/core/links.ts`) — with `(none)`
placeholders. `--json` →
`{outlinks: [{target_title, key|null, title|null, bucket|null}], backlinks,
twoHop: [{via, docs}]}`. The former `kura link broken` (unresolved links
grouped by target title) is now [`kura audit links`](#kura-audit); creating
the missing target later auto-resolves the links (SPEC §10.1), which
`kura audit links` then reflects.

### `kura alias`

```
kura alias ls <doc> [--bucket b] [--json]
kura alias add <doc> <alias...> [--bucket b] [--json]
kura alias rm <doc> <alias...> [--bucket b] [--json]
```

Manages a document's aliases (alternate titles —
[document-notation.md](document-notation.md)): `[[alias]]` links resolve to
the document, `<doc>` specifiers match it, and keyword search indexes it at
title weight. `add` validates each alias (`normalizeAlias`: non-empty,
no `[ ] | /` or newlines — usage error otherwise), skips the document's own
title and case-insensitive duplicates, and self-heals matching unresolved
links; `rm` matches case-insensitively and re-resolves links that resolved
through the removed alias. Text output: the alias list (`ls`, one per
line, or `no aliases for #key title`), `added N alias(es) to #key title`,
`removed N alias(es) from #key title`. `--json` → `ls`
`{key, title, aliases}`; `add` `{key, added, aliases}`; `rm`
`{key, removed, aliases}` (`aliases` is the post-change list).

### `kura history`

```
kura history <doc> [--bucket b] [--json]
kura history show <doc> <rN> [--bucket b] [--json]
kura history restore <doc> <rN> [--bucket b] [--json]
```

Document revision history (`src/cli/commands/history.ts`, backed by
`document_revisions` — [data-model.md](data-model.md)). Every content,
title, or path change snapshots the replaced state; autosave bursts
coalesce into one revision per burst and only the newest 100 per document
are kept.

- **List** (no subcommand): revisions newest first, one per line —
  `r<id>  <saved_at>  <full path/title>  <bytes>B  <hash8>` — or
  `no revisions for #key title`. `--json` →
  `{key, title, revisions: [{id, title, path, content_hash, saved_at,
  created_at, bytes}]}`.
- **`show`**: prints the revision's content verbatim (`--json` adds
  `content` to the revision record). `<rN>` accepts `r12` or `12`; a
  malformed id is a usage error (exit 2), an unknown one `NotFoundError`
  (exit 3).
- **`restore`**: replaces the current body with the revision's **content
  only** — title and path stay as they are, so a restore can never collide
  with another document's full path. It goes through `updateDocument`, so
  the replaced state is snapshotted first: a restore is itself undoable.
  Output `restored #key title to rN (content only)`; `--json` →
  `{key, restored: N}`.

Point-in-time reads live on `kura get --as-of` (above). A **deleted
document's history is deleted with it** (`ON DELETE CASCADE`).

### `kura changes`

```
kura changes --since <time> [--bucket b] [--limit 50] [--json]
```

Change feed (`src/cli/commands/changes.ts`, core `src/core/changes.ts`):
documents created or updated after `--since`, newest first, default limit
50. Built for agents catching up at session start
(`kura changes --since 7d --json`); pure SQL, so it works fully without an
LLM provider.

- `--since` is **required** — missing or unparsable values are a usage
  error (exit 2). It accepts a relative time (`30m` / `24h` / `7d` / `2w`)
  or anything `Date`-parsable (ISO 8601, `YYYY-MM-DD`), normalized to a
  SQLite datetime by `parseSince`.
- `kind` is `created` when `created_at > since`, `updated` otherwise. For
  updated documents the state as of `--since` comes from the revision
  history (`revisionMetaAsOf` — [data-model.md](data-model.md)), yielding the
  `content_changed` / `renamed` / `moved` flags plus the previous
  title/path. A pruned or coalesced-away snapshot degrades to "changed,
  previous state unknown" (`content_changed: true`, previous fields
  `null`).
- **Deletions are not tracked** — revisions are deleted with their
  document, so nothing outlives a `kura rm`.

Plain output, one change per line (details only where they apply):

```
created  #a1b2c3d4  clips/記事タイトル  [main]  2026-07-19 03:12:44
updated  #b2c3d4e5  検索設計  [main]  2026-07-19 04:01:02  (content, renamed from 旧タイトル)
```

`--json` → `{since, changes: [{key, bucket, path, title, kind, created_at,
updated_at, content_changed, renamed, moved, previous_title,
previous_path}]}` (`since` is the normalized SQLite datetime actually
used).

### `kura triage`

```
kura triage [<doc>...] [--bucket b] [--limit n] [--steps dedupe,title,tags,path,links] [--apply] [--json] [--redo]
```

The backlog-organizing umbrella for the "dump documents first, organize
later" workflow (`src/cli/commands/triage.ts`, core `src/core/triage.ts`).
Walks the **triage backlog** — documents at the bucket root **or** without
tags, excluding ones already triaged and unchanged since
(`(path = '' OR untagged) AND (triaged_at IS NULL OR updated_at >
triaged_at)`; `listTriageBacklog`) — newest-updated first, scoped to
`--bucket` or `general.default_bucket`. With `<doc>` positionals it triages
exactly those documents (any bucket, resolved by `resolveDoc`) instead of
the backlog. `--redo` re-includes already-triaged documents; `--limit` caps
the backlog slice.

Each document is piped through five organizing engines in `TRIAGE_STEPS`
order (`--steps` selects a subset; an unknown step name is a usage error),
each of which degrades independently (invariants R4):

1. **dedupe** — exact duplicates (same `content_hash`, no LLM) plus
   near-duplicates (per-chunk embedding KNN + an LLM verdict on the closest
   few); `src/core/dedupe.ts`.
2. **title** — a concise, specific title from the generation model, or none
   when the current title already fits; `src/core/titling.ts`
   (LLM-required, cached under purpose `title`).
3. **tags** — tag suggestions that reuse the existing taxonomy, minus tags
   already on the document; `suggestTagsForText` in `src/core/tagging.ts`
   (LLM-required, purpose `tag`).
4. **path** — a document path for **unfiled** documents only (skipped once a
   document is filed) from structural / semantic / LLM signals;
   `src/core/filing.ts` (the former `mv suggest`, purpose `path`).
5. **links** — related documents to link, appended under an intentionally
   Japanese `## 関連` heading; `src/core/linking.ts` (semantic neighbours
   judged for relatedness, purpose `link`; FTS keyword neighbours unjudged
   without a provider).

**Modes.** On a TTY with no `--apply`, each step prompts `[y/e/n/s/q]`
(`y` apply, `e` edit the value, `n` skip the step, `s` keep the document
as-is and mark it triaged, `q` quit the whole run without marking the
current document); the dedupe and links steps use `[y/n/s/q]` (no edit).
`--apply` (also the non-TTY path) applies every suggestion **except
duplicate merges** — merges are never automatic; a possible duplicate is
only reported, pointing at interactive `kura triage` or `kura audit dupes`.
`--json` is a **dry run** (never applies) and prints a stable array
(invariants R7):

```json
[{ "key": "…", "title": "…", "steps": {
    "dedupe": { "candidates": [{ "key", "title", "similarity", "exact", "verdict"? }] },
    "title": { "proposed": "…", "reason"? },
    "tags": ["…"],
    "path": { "path": "…", "source": "llm|signals", "reason"? },
    "links": [{ "title", "similarity", "judged" }]
  }, "warnings": ["…"] }]
```

A step key is **omitted** when that step did not run; `title` / `path` are
`null` when the step ran but proposed nothing. A document's `triaged_at`
(schema v6, [data-model.md](data-model.md)) is stamped when its flow
completes (and when `s` keeps it as-is; `q` quits without stamping the
current document); `markTriaged` leaves `updated_at` alone, so editing the
document afterwards bumps `updated_at` past `triaged_at` and re-enters it
into the backlog. Applying goes through `updateDocument` / `addTagsToDoc` /
`appendRelatedLinks` (links rewrite and derived tables re-sync as usual);
a merge goes through `mergeDuplicate` (alias + tag transfer, then delete).

**Degraded operation** — `kura triage` **never exits 4**: with no provider a
warning prints and only the provider-free work runs (path suggestions from
structural / keyword signals, link candidates from FTS keyword search,
exact-hash dedupe), while the title, tags, and near-duplicate-verdict steps
are skipped with a per-run warning. Exit codes: 0 (including an empty
backlog — `no documents in the triage backlog of bucket '…'`, or `[]` for
`--json`), 2 for bad flags (`--json` + `--apply` is mutually exclusive; an
unknown `--steps` value).

### `kura audit`

```
kura audit [contradictions|dupes|tags|links] [--bucket b] [--limit n] [--apply] [--json]
```

Stock-side knowledge-base health checks (`src/cli/commands/audit.ts`).
Without a subcommand it runs **every** check that can run and prints a
combined, report-only summary; a subcommand runs just that check. `--bucket`
scopes where applicable; `--limit` caps the documents/pairs the duplicate
and contradiction passes examine. `--apply` (dupes/tags only) offers
per-item confirmation.

- **`contradictions`** — the original contradiction audit (core
  `src/core/audit.ts`): semantically close passages from the most recently
  updated documents are paired via embedding KNN (`k = 6`, capped at
  `--limit`, default 10) and the generation model judges each pair for
  contradictory statements (intentionally Japanese prompt; verdicts cached
  under `llm_cache` purpose `audit`, keyed on the sorted pair of excerpt
  hashes). **LLM-required when invoked explicitly** —
  `kura audit contradictions` calls `requireProvider` and exits 4 without
  one. Plain output lists only contradictory pairs; `--json` →
  `{examined_pairs, contradictions: [{a, b, similarity}]}` with
  `a` / `b` = `{key, title, path, bucket, excerpt}` (unchanged from the
  former top-level `kura audit`):

  ```
  ⚠ #a1b2c3d4 猫と牛乳（推奨） <-> #b2c3d4e5 猫と牛乳（注意）  (similarity 0.873)
      A: 猫に牛乳を与えてよい。毎日あげよう。
      B: 猫に牛乳は禁物。お腹を壊すことがある。
  1 contradiction(s) among 3 pair(s)
  ```

- **`dupes`** — store-wide duplicate detection (core `src/core/dedupe.ts` +
  `similarChunkPairs` from `src/core/audit.ts`): exact duplicates by
  `content_hash` (no LLM, survivor = most recently updated) plus
  near-duplicate pairs (shared chunk-pair KNN capped at the 0.6 similarity
  floor + an LLM verdict; **without a provider it lists the close pairs
  unjudged**). `--apply` confirms each merge interactively (`mergeDuplicate`:
  alias + tag transfer, then delete the duplicate); merges are never
  non-interactive. `--json` →
  `{exact: [[{key, title}], …], near: [{a, b, similarity, verdict?}]}`
  (`a` / `b` = `{key, title}`).
- **`tags`** — the former `kura tag audit`, verbatim behavior (`auditTags` in
  `src/core/gardening.ts`): tag merge candidates (edit distance, plus
  embedding similarity when a provider is up) and oversized tags (attached to
  > 30 % of documents); degrades to edit-distance only without a provider.
  `--apply` merges via `renameTag` with per-item confirmation. **New
  `--json`** →
  `{merges: [{from, to, reason, similarity}], oversized: [{path, count,
  share}]}`.
- **`links`** — the former `kura link broken` (`brokenLinks`): unresolved
  wiki links grouped by target title; `--bucket` filters by the **source**
  document's bucket and a nonexistent bucket exits 3. `--json` is
  **byte-identical** to the old command's: `[{target_title, sources}]`.

**Bare `kura audit`** runs `links` → `tags` → `dupes` → `contradictions` in
that order, report-only (it ignores `--apply`), with `== links ==` /
`== tags ==` / `== dupes ==` / `== contradictions ==` section headers; it
**skips contradictions with a stderr note when no provider is reachable**
and never exits 4 (exit 0). `--json` → `{links, tags, dupes,
contradictions?}` — the `contradictions` key is present only when a provider
judged the pairs. Bad flags / an unknown subcommand are usage errors
(exit 2). Neither `kura audit`'s subcommands nor `kura triage` have MCP
counterparts yet (see [roadmap.md](roadmap.md)).

### `kura bucket`

```
kura bucket ls [--json]
kura bucket add <name> [--desc <text>]
kura bucket rm <name> [--force]
kura bucket mv <old> <new>
```

Bucket names must match `^[a-z0-9][a-z0-9-]*$` (`src/core/buckets.ts`,
usage error otherwise). `rm` refuses the configured
`general.default_bucket` (usage error) and refuses non-empty buckets
(`ConflictError`, exit 1) unless `--force`, which deletes every contained
document first and reports the count. `mv` renames; duplicates conflict.
`ls` shows `name  N documents  description`; `--json` →
`[{name, description, documents, created_at}]`.

---

## `kura clip`

```
kura clip <url> [--bucket b] [--tags t1,t2] [--no-llm] [--dry-run] [--force]
```

`src/cli/commands/clip.ts` (SPEC §7.5). Only `http(s)://` URLs are accepted.
Pipeline: fetch + Readability extraction (`src/core/clip/extract.ts`, 30s
timeout, explicit User-Agent) → Markdown formatting
(`src/core/clip/format.ts`): the generation model reformats and extracts a
title (cached under purpose `clip`), or turndown converts mechanically with
`--no-llm` — and also, **with a warning, when no provider is reachable**
(clip never exits 4) → LLM tag suggestions seeded with the existing tag list
(failures are warnings) → save with `source_url`.

- **Clips are filed under the `clip.path` document path** (config, default
  `"clips"`; `""` saves to the bucket root — see
  [configuration.md](configuration.md)). A (bucket, path, title) collision
  retries the save as `タイトル (2)`, `タイトル (3)`, …
  (`createDocumentWithRetry`, up to 50 attempts).
- **URL duplicate detection is scoped per bucket**: an existing document
  with the same `source_url` in the target bucket triggers a `[y/N]` update
  confirmation on a TTY; on a non-TTY without `--force` the command prints
  the conflict and exits 1. `--force` updates unconditionally. Updates keep
  the doc key (and the existing document's path) and apply `--tags`;
  suggested tags are added as `source='auto'`.
- `--dry-run` prints the title, a `> url / path / formatter / tags` info
  line, and the formatted Markdown without saving — useful to preview the
  LLM-vs-turndown output.
- `--tags` supplies manual tags in addition to the suggestions.
- Progress (`fetching <url> ...`) goes to stderr.

---

## Servers

### `kura browser`

```
kura browser [--port 7578] [--no-open]
```

Starts the REST + SPA server (`src/server/http.ts`) on `127.0.0.1` only.
The port defaults to `browser.port`; on EADDRINUSE it retries +1 up to 10
times. Prints the URL, opens the default browser unless `--no-open`, and
stays resident until SIGINT/SIGTERM. Details in
[http-api.md](http-api.md) and [browser-ui.md](browser-ui.md).

### `kura mcp`

```
kura mcp [--print-config]
```

Runs the MCP server on stdio (`src/server/mcp.ts`) until the client
disconnects. `--print-config` prints ready-to-paste `claude mcp add` and
`.mcp.json` snippets instead of starting. Tool inventory in
[mcp-server.md](mcp-server.md).

---

## Agent integration

### `kura skills`

```
kura skills install [--dir <path>] [--json]
kura skills uninstall [--dir <path>]
kura skills show
```

`src/cli/commands/skills.ts`. Installs `kura-cli/SKILL.md` — an agent skill
that teaches AI coding agents to drive kura from the CLI (the three search
modes, `--json` shapes, exit codes, non-interactive recipes) — into the
agent skills directory, default `~/.agents/skills` (the tool-agnostic
shared location; `--dir` overrides it, e.g. a project's `.claude/skills`).

- The skill body lives at `src/cli/skills/kura-cli/SKILL.md` and is embedded
  into the binary as a string (`with { type: "text" }`, the same mechanism
  as the SQL migrations); the `{{KURA_VERSION}}` placeholder is stamped at
  install time.
- `install` is idempotent — `Installed` / `Updated` / `Already up to date`
  (`--json`: `{action: "installed" | "updated" | "unchanged", path}`). A
  reinstall overwrites local edits; the file footer warns about this.
- `uninstall` removes `SKILL.md` (and the `kura-cli/` directory when it is
  empty), exits 3 when not installed. `show` prints the skill to stdout.
- The skill documents commands verbatim: when the CLI surface changes, the
  skill body changes in the same PR (it is source under `src/`, so the
  rename-sweep rule covers it).

---

## How commands relate

- **`init` → everything else**: `getDb()` (`src/core/db.ts`) refuses to run
  any data command when the DB file doesn't exist ("Run 'kura init' first",
  exit 1). `KURA_DB=:memory:` bypasses this for tests. `init` ends by
  pointing at `doctor`; `doctor --fix` can finish an interrupted `init`
  (vaporetto re-download, trigram→vaporetto reindex).
- **`add`/`edit`/`clip`/`import` → `embed` → `vsearch`/`query`**: writes
  never block on embeddings (`embedded_at = NULL`); `vsearch`/`query`
  auto-backfill ≤ 100 pending chunks and warn beyond that; `embed` clears
  the backlog explicitly and stamps meta so `doctor` can detect model drift.
- **Config embedding change → `doctor --fix` → `embed`**: changing
  `llm.models.embedding*` makes `doctor` warn, `doctor --fix` recreate
  `chunks_vec`, and `kura embed` repopulate it (see
  [configuration.md](configuration.md)).
- **`mv`/`edit` (rename/move) ↔ `link`**: renames and path moves rewrite
  referrer bodies; creating a document auto-resolves matching unresolved
  links; `kura audit links` and `doctor --fix` expose/repair the remainder.
- **`export` ↔ `import`**: a lossless round-trip keyed on `kura_key`
  (re-import updates in place, even into a different `KURA_HOME`).

## Deviations from SPEC

- **`--bucket` default (SPEC §7 global conventions).** SPEC says `<doc>`
  resolution defaults to `config default_bucket`; the implementation
  resolves titles across **all buckets** and errors on ambiguity instead.
  Search commands defaulting to all buckets matches SPEC.
- **Hierarchical document paths are an addition** (SPEC §7 has no `--path` /
  `ls --prefix` flags, no `kura mv --prefix`, and no `clip.path`); the doc
  specifier's full-path stage and the path-aware `export`/`import` layout
  ride on schema v2 (see [data-model.md](data-model.md)).
- **`init --no-download` is an addition** (not in SPEC §7.1); it exists for
  offline installs and is the backbone of test isolation.
- **`edit` round-trips frontmatter + body**, not "the body only" as SPEC
  §7.2 words it — title/tags/bucket edits in the frontmatter are applied on
  save.
- **`add` title precedence** puts frontmatter `title:` above `--title`
  (SPEC doesn't define an order).
- **No idle background embedding in `browser`/`mcp`** (SPEC §5.3 item 3).
  Only the ≤100-chunk pre-search auto-backfill and explicit `kura embed`
  exist; the REST search endpoint shares the same `ensureEmbeddings` path.
- **`tag suggest` requires `--doc` or `--untagged`** (SPEC's synopsis shows
  both as optional), and `--apply` on a non-TTY applies without interactive
  confirmation (SPEC describes interactive confirmation only).
- **`--json` also works on `add`/`export`/`import`** (SPEC promises it for
  read commands only).
- **`clip --force` overwrite confirmation is per-bucket**: the same URL in a
  different bucket creates a second document rather than prompting.
- **Trigram short-term LIKE fallback** (`search` with <3-char terms) is an
  implementation addition beyond SPEC §5.4's escape rules.
