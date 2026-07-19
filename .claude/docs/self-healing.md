# Self-healing and knowledge health

> Covers SPEC §10. Key sources: `src/core/doctor.ts`, `src/core/gardening.ts`,
> `src/core/stale.ts`, `src/core/links.ts`, `src/core/aliases.ts`,
> `src/core/documents.ts`,
> `src/core/{triage,dedupe,titling,linking,tagging,filing}.ts`,
> `src/cli/commands/{doctor,tag,ls,status,triage,audit}.ts`,
> `tests/m6.test.ts`, `tests/aliases.test.ts`.

kura assumes its environment drifts — extensions go missing, configs change,
indexes desync — and treats recovery as a feature: diagnose with
`kura doctor`, repair with `kura doctor --fix`, and keep the knowledge base
healthy over time with link auto-resolution, tag gardening, and staleness
detection. The standing principle (SPEC §10.4): **surface problems and prompt
review; never delete content automatically.**

## `kura doctor` — diagnostics

`src/cli/commands/doctor.ts` runs the checks below and prints one
`✓ / ⚠ / ✗` line each. Exit code is 1 if any check **fail**ed, 0 otherwise
(warnings don't fail the run). Provider probes use a 2 s timeout.

| Check | ok | warn | fail |
| --- | --- | --- | --- |
| `platform` | always — reports `platform-arch`, Bun version, `KURA_HOME` | — | — |
| `homebrew-sqlite` (macOS only) | dylib exists at the arch-specific path | — | missing → `brew install sqlite` |
| `config` | parsed, or absent (defaults apply) | — | `config.toml` fails to parse (checks continue on defaults) |
| `sqlite-vec` | loads into a probe `:memory:` DB and `vec_version()` answers | — | load failure |
| `vaporetto` | loads with entry point `sqlite3_vaporetto_init` **and** passes a live round-trip: index a Japanese sentence, match it via `vaporetto_or_query('全文検索')` | platform unsupported (trigram fallback), or not yet installed (`kura init` will download) | load error, or the tokenization round-trip misses |
| `database` | `PRAGMA quick_check` = ok — reports path, schema version, doc count, tokenizer | DB not created yet (`run 'kura init'`); also relays `openDatabase()` warnings | `quick_check` failure or the DB cannot be opened |
| `fts-sync` | (emitted only on mismatch) | `documents` vs `documents_fts` row counts differ → rebuild required | — |
| `fts-tokenizer` | (emitted only when relevant) | DB was built with trigram but vaporetto now works → reindex recommended | — |
| `embedding-model` | (emitted only on mismatch) | `meta.embedding_model` ≠ config → `kura embed --all` | — |
| `ollama` | `GET /api/tags` reachable (reports model count) | unreachable | — |
| `ollama-models` | embedding / reranker / generation models all installed (names compared case-insensitively, `:latest` stripped) | missing models, with ready-to-paste `ollama pull ...` hints | — |
| `lmstudio` | `GET /v1/models` reachable | unreachable | — |
| `llm-provider` | resolved provider (explicit config value, or auto: ollama → lmstudio) | `none` → degraded mode, keyword search only | — |

The vaporetto check deliberately exercises real tokenization rather than just
dlopen success, so a broken model embed shows up as `fail`, not a silent
search regression.

## `kura doctor --fix` — repairs

Fixes run **before** the diagnostic pass, so the printed report reflects the
repaired state. Order (from `runFixes`):

1. **vaporetto re-fetch** — if the platform is supported and the extension
   file is missing, `ensureVaporetto({ download: true })` re-downloads with
   SHA256 verification (see [native-extensions.md](native-extensions.md)).
   Failures are reported, not fatal.
2. **`vec-recreate`** (`recreateVecIfModelChanged`) — if
   `meta.embedding_model` / `meta.embedding_dimensions` disagree with config,
   drop and recreate `chunks_vec` with the new dimension count, set every
   `chunks.embedded_at = NULL`, and update meta. All vectors are invalidated,
   which is why this runs first — later steps then operate on the new table.
   The report tells the user to run `kura embed` to regenerate.
3. **`gc-orphans`** (`gcOrphans`) — delete `chunks` whose document is gone,
   then `chunks_vec` rows whose chunk is gone. Orphans are **counted with
   explicit `SELECT COUNT(*)` before deleting** because the `vec0` virtual
   table reports inaccurate `changes` counts — don't "simplify" this to
   `result.changes`.
4. **`content-hash`** (`fixContentHashes`) — recompute SHA256 for every
   document; on mismatch, route the row through `updateDocument()` with its
   own content and its **original `updated_at` preserved**. Going through the
   repository means the fix re-chunks and re-syncs FTS/links/tags in one
   transaction instead of just patching the hash column.
5. **`fts-rebuild`** (`rebuildFtsIfNeeded`) — if `documents_fts` and
   `documents` row counts differ, wipe FTS and re-insert every document with
   its synthesized `tags` and `aliases` columns (space-joined tag paths /
   aliases).
6. **`resolve-links`** (`resolveAllUnresolvedLinks`) — re-runs the shared
   three-stage resolution (`resolveLinkTarget` in `src/core/links.ts`) for
   every `target_id IS NULL` link, **scoped to the source document's
   bucket**, case-insensitive, self-links excluded: full-path spellings
   resolve exactly; a short-form title or alias resolves only when exactly
   one candidate exists — **ambiguous short forms are skipped, not
   force-resolved** (they stay visible in `kura audit links`).
7. **`fts-retokenize`** (`retokenizeFts`) — only when the DB tokenizer is
   `trigram` but vaporetto loaded in this process: drop `documents_fts`,
   recreate it with `tokenize='vaporetto'`, re-insert all rows, and update
   `meta.fts_tokenizer`. This is the trigram → vaporetto upgrade path
   (e.g. a DB initialized with `--no-download`).

Each helper in `src/core/doctor.ts` is idempotent and returns `null` when
there is nothing to do; `--fix` prints `fixed: <action> <detail>` per applied
repair or `--fix: nothing to repair`.

## Link self-healing

Wiki-link health is maintained continuously, not just by doctor
(SPEC §10.1; implementation in `src/core/links.ts` and
`src/core/documents.ts`):

- **Write-first linking.** Saving a document records every `[[title]]` /
  `[[full/path/Title]]` in `links`, resolving targets through the shared
  three-stage resolution (`resolveLinkTarget`: full path first, then
  title, then alias — the last two only when exactly one candidate exists;
  same bucket, case-insensitive —
  see [document-notation.md](document-notation.md)); non-matches **and
  ambiguous short forms** are stored with `target_id = NULL` (unresolved),
  not dropped or force-resolved.
- **Auto-resolution on create/rename/move/alias.** `createDocument` and any
  title/path/bucket-changing `updateDocument` call `resolveUnresolvedLinks`,
  which rewires unresolved links whose `target_title` matches the new title,
  full path, **or one of the document's aliases** (same bucket,
  case-insensitive, ambiguity guard applies) — the "write the link first, it
  connects when the page appears" behavior. `addAliasesToDoc`
  (`src/core/aliases.ts`) triggers the same pass, so `[[alias]]` links
  written before the alias existed connect when it is added.
  Already-resolved links are **sticky**: creating a second same-title
  document later does not retro-unresolve them.
- **Alias removal re-resolves.** `removeAliasesFromDoc` re-runs
  `resolveLinkTarget` for every link that pointed at the document via a
  removed alias (`reresolveLinksForRemovedAliases` in
  `src/core/aliases.ts`) — each either finds another target or returns to
  unresolved; nothing keeps pointing at a document through an alias it no
  longer has.
- **Rename rewires, delete unresolves.** `kura mv` rewrites `[[old title]]`
  and `[[old/full/path]]` occurrences in referrers' bodies inside the same
  transaction (a path-only move rewrites just the full-path spelling — the
  rewrite matrix lives in
  [document-notation.md](document-notation.md#unresolved-links-and-rename-rewriting)).
  Deleting a document flips incoming links back to unresolved via the
  schema's `ON DELETE SET NULL` — the link text survives and re-resolves if
  the page is recreated. Moving a document to another bucket explicitly
  nulls its incoming links, because resolution is bucket-scoped.
- **Visibility.** `kura audit links` (the former `kura link broken`) lists
  unresolved links grouped by target title; `kura status` reports the
  unresolved-link count; doctor's `resolve-links` fix handles bulk repair
  after imports or bucket surgery.

## Triage — organizing the backlog

`kura triage` (`src/cli/commands/triage.ts`, core `src/core/triage.ts`) is
the "dump documents first, organize later" workflow: a per-document pipeline
that proposes structure for the **triage backlog** and applies it only on
confirmation. Full CLI surface (flags, `[y/e/n/s/q]` prompts, the `--json`
contract, exit codes) in
[cli-reference.md](cli-reference.md); this section covers the mechanics.

- **Backlog definition** (`listTriageBacklog`). A document is in the backlog
  when it is **unfiled or untagged** and has not been triaged since it last
  changed:
  `(d.path = '' OR NOT EXISTS document_tags) AND (triaged_at IS NULL OR
  updated_at > triaged_at)`, newest-updated first, bucket-scoped. `--redo`
  drops the `triaged_at` clause; explicit `<doc>` positionals bypass the
  backlog entirely. The same predicate (minus the `triaged_at` clause)
  backs the `unfiled` / `untagged` / `triageBacklog` counts in
  `collectStats` and the `kura status` **Backlog** line.
- **`triaged_at` semantics** (schema v6, `markTriaged` in
  `src/core/documents.ts`, [data-model.md](data-model.md)). Stamped when a
  document's flow completes; `markTriaged` deliberately **does not touch
  `updated_at`** (like `touchAccess` / `setFavorite`), so a later edit bumps
  `updated_at` past `triaged_at` and the document re-enters the backlog. It
  is runtime bookkeeping, not exported/imported via frontmatter.
- **Step engines** (`triageDocument`, run in `TRIAGE_STEPS` order, each
  degrading independently per invariants R4):
  - **dedupe** — `exactDuplicates` (content-hash, no LLM) + `nearDuplicates`
    (per-chunk embedding KNN, LLM verdict on the closest few, cached under
    purpose `dupe`); `src/core/dedupe.ts`.
  - **title** — `suggestTitleForDocument` (LLM, purpose `title`), null when
    the current title already fits; `src/core/titling.ts`.
  - **tags** — `suggestTagsForText` (LLM, purpose `tag`), minus tags already
    on the document; `src/core/tagging.ts`.
  - **path** — `suggestPathForDocument` for unfiled documents only, the
    filing-assistant signal layers (structural + semantic + LLM pick, purpose
    `path`); `src/core/filing.ts`.
  - **links** — `suggestLinksForDocument` (semantic neighbours judged for
    relatedness, purpose `link`; FTS keyword neighbours without a provider),
    applied by appending `- [[Title]]` bullets under a trailing `## 関連`
    heading (`appendRelatedLinks`); `src/core/linking.ts`.
- **Merge is the one destructive action, and it is never automatic.**
  `mergeDuplicate` (`src/core/dedupe.ts`) makes the duplicate's title and
  aliases into aliases of the survivor, transfers its tags, then deletes it —
  all in one transaction through the repository (invariants R1/R2). Alias
  self-healing re-resolves any `[[old title]]` links onto the survivor, and
  carrying the tags means a merge never loses organization. `kura triage`
  offers merges only interactively; `--apply` reports possible duplicates but
  never merges them.

Like the rest of self-healing, triage **surfaces and proposes; it never
deletes or rewrites without confirmation** (SPEC §10.4) — the sole exception
being a merge the user explicitly accepts.

## Tag gardening

### `kura audit tags [--apply]` (`auditTags` in `src/core/gardening.ts`)

Pairwise scan of all tags, producing **merge candidates** and **oversized
tags**. The edit-distance half lives on its own as `tagMergeCandidates(tags)`
— pure, synchronous, no database and no provider — because the browser's
statistics screen asks for it on every page view (`GET /api/insights`):

- Skip any ancestor/descendant pair (`tech` vs `tech/db` is hierarchy, not
  duplication).
- Flag a pair when the **normalized edit distance**
  (Levenshtein / max length) is **≤ 0.25** or it is a simple singular/plural
  variant (`+s` / `+es`). Pairs whose lengths differ by more than the
  threshold are skipped before the DP runs — the edit distance is at least the
  length gap, so they cannot qualify.
- If an LLM provider is available, embed all tag paths once and additionally
  flag pairs (not already flagged) with **cosine similarity > 0.85** —
  catches semantic duplicates like `db` / `database` that edit distance
  misses. Without a provider, the CLI warns and audits with edit distance
  only.
- **Merge direction**: into the more-used tag; on a tie, into the shorter
  path. Candidates are de-duplicated per pair and sorted by similarity
  descending.
- **Oversized**: any tag attached to **> 30 %** of all documents is reported
  as a split candidate (it no longer discriminates).

`--apply` confirms each merge interactively (y/N on a TTY) and executes it
via `renameTag`, which moves descendant tags along and merges into an
existing target. Oversized tags are report-only — splitting is a human
decision. The `--json` shape (`{merges, oversized}`) lives in
[cli-reference.md](cli-reference.md).

### Tag suggestion (the triage `tags` step)

LLM tag suggestions (`suggestTagsForText` in `src/core/tagging.ts` — moved
out of the clip pipeline so tag suggestion has an owner of its own).
Requires a provider. The prompt includes the **existing tag list** and
strongly prefers reusing the current taxonomy over inventing new tags;
responses are cached in `llm_cache` (purpose `tag`). Two consumers today:
the **tags step of `kura triage`** (which drops tags already on the
document, then confirms/applies the rest with `source='auto'`, keeping
LLM-assigned tags distinguishable from manual ones) and `kura clip`. The
standalone `kura tag suggest` command is gone — `kura triage` subsumes it.

## Staleness detection

`src/core/stale.ts` scores documents older than `general.stale_days`
(default 180):

```
staleScore = (daysSinceUpdate / staleDays)
           / ((1 + ln(1 + accessCount)) × (1 + 0.5 × backlinks))
```

Age alone pushes the score up; being read (log-damped) or being linked to
(linear, factor 0.5 per backlink) pulls it down. A document is a staleness
candidate when the score is **≥ 1.0**; results are sorted descending so the
most neglected documents surface first. An untouched, unread, unlinked
document crosses 1.0 exactly at `stale_days`; a document with 10 reads or a
couple of backlinks stays below threshold for much longer
(see `tests/m6.test.ts`).

Surfaces:

- **`kura ls --stale`** — filters to score ≥ 1.0 and orders by score
  (`--limit` applies after scoring).
- **`kura status`** — stale count plus the top five with days / reads /
  score.
- **`GET /api/stale`** — the REST wrapper over `staleDocuments()`, added for
  the browser home dashboard; the **first place the full `staleScore` is
  exposed outside the CLI** (bucket-scoped, most-neglected first — see
  [http-api.md](http-api.md)).
- **Browser UI** — the home dashboard's 放置気味 section and its nudge chip
  read `GET /api/stale`, so they rank by the full score; the stat card and the
  graph's dimmed stale nodes use the cheaper cutoff (below);
  `GET /api/docs?stale=1` filters the list page.

Nothing is ever auto-deleted or archived: staleness exists to *prompt
review*.

## Deviations from SPEC

- **Embedding-model change is fixed, not just suggested.** SPEC §10.2 said
  doctor should "suggest recreating `chunks_vec`". `doctor --fix` performs
  the recreation (`vec-recreate`) and resets `embedded_at` itself; only the
  re-embedding (`kura embed`) is left to the user, since that needs a live
  provider and real time.
- **`tag suggest` targets untagged documents only.** SPEC §10.3 mentioned
  "untagged or *under-tagged*" documents; there is no under-tagged heuristic
  — the flag is `--untagged` (or an explicit `--doc`).
- **Two notions of "stale" coexist.** The full `staleScore` (age dampened by
  reads and backlinks, ranked) is now computed on both sides: the CLI
  (`ls --stale`, `status` top-5) **and** `GET /api/stale`, which the browser
  home dashboard consumes. The cheaper `updated_at < now − stale_days`
  **cutoff** still backs `GET /api/docs?stale=1`, the graph's `stale` node
  flag, and the `staleDocuments` count in `collectStats`. The cutoff is a
  superset of the score ≥ 1.0 candidates and cheap enough for per-request
  filtering — but the two notions differ, which matters if you change either
  side: `/api/stale` (scored, thresholded at 1.0) and the stat-card
  `staleDocuments` count (cutoff) can legitimately disagree.

## Related docs

- [native-extensions.md](native-extensions.md) — the extension/tokenizer
  states doctor diagnoses; retokenization mechanics
- [data-model.md](data-model.md) — consistency rules that the fixes restore;
  `links` / `meta` schema
- [search-pipeline.md](search-pipeline.md) — embedding backfill that follows
  `vec-recreate`
- [llm-providers.md](llm-providers.md) — provider resolution behind the
  `ollama` / `lmstudio` / `llm-provider` checks
