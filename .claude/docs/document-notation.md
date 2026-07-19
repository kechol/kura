# Document Notation

> Covers SPEC §4. Key sources: `src/core/wiki.ts`, `src/core/frontmatter.ts`, `src/core/links.ts`, `src/core/aliases.ts`, `src/core/documents.ts`, `tests/wiki.test.ts`, `tests/aliases.test.ts`

Document bodies are Markdown (GFM); raw HTML is stored with
`content_type = 'html'`. On every save the repository extracts wiki links
and hashtags from the body and syncs them into `links` / `document_tags`
(see [architecture.md](architecture.md) for the transaction, and
[data-model.md](data-model.md) for the tables).

## Wiki links

Syntax: `[[タイトル]]` or `[[タイトル|表示テキスト]]` (`LINK_RE` in
`src/core/wiki.ts`).

- The title part may not contain `[`, `]`, `|`, or a newline. The first `|`
  splits title from display; later `|` characters stay in the display text
  (`[[A|B|C]]` → title `A`, display `B|C`).
- Title and display are **trimmed**; an empty title (`[[]]`, `[[ | x]]`) is
  ignored; an empty display (`[[メモ|]]`) is treated as no display (`null`).
- Unclosed `[[` is plain text; with nested-looking input (`[[外側[[内側]]]]`)
  only the innermost bracket pair becomes a link.
- Extraction **deduplicates by lowercased title**, keeping the first
  occurrence in document order (`[[SQLite]] と [[sqlite]]` yields one link).
- **Resolution is three-stage, bucket-scoped, and case-insensitive**
  (`resolveLinkTarget` in `src/core/links.ts` — the single shared
  implementation behind `syncLinks`, `resolveUnresolvedLinks`, and doctor's
  `resolveAllUnresolvedLinks`):
  1. `[[full/path/Title]]` — exact match on the **computed full path**
     (`path === '' ? title : path + '/' + title`; unique per bucket by
     construction).
  2. `[[Title]]` — title match, resolved only when **exactly one** candidate
     exists (an explicit `LIMIT 2` count guard — the old scalar subquery
     silently picked an arbitrary row). An ambiguous short form stays
     unresolved (`target_id = NULL`) and surfaces via `kura audit links` and
     doctor.
  3. `[[Alias]]` — match against `document_aliases`, resolved only when
     **exactly one** document carries the alias (same `LIMIT 2` guard).

  A stage that matches at all — even ambiguously — ends the search: an
  ambiguous title never falls through to aliases. `[[bun runtime]]` resolves
  to a same-bucket document titled `Bun Runtime`, never to another bucket.
  Self-references stay unresolved. Unresolved links keep the raw
  `target_title` with `target_id = NULL`.
- **Already-resolved links are sticky**: creating a second same-title
  document later does not retro-unresolve links that already point at the
  first one — resolution only re-runs when the referring document is saved.

### Code is never notation

Both extraction and rename rewriting ignore code (`visibleLines` /
`maskInlineCode` in `src/core/wiki.ts`):

- **Fenced blocks** — a line-by-line state machine. A fence opens with up to
  3 spaces of indent plus 3+ backticks or tildes (`FENCE_OPEN_RE`); a
  backtick fence whose info string contains a backtick is not a fence
  (CommonMark). It closes on a run of the same character at least as long as
  the opener (`FENCE_CLOSE_RE`) — a 5-backtick run closes a 3-backtick
  opener. An unclosed fence swallows everything to EOF. Info strings on the
  opening line are not scanned (a fence opened as ```` ```js #not-a-tag ````
  produces no tag).
- **Inline code** — backtick spans are masked before regex matching. A span
  is a pair of **equal-length** backtick runs (CommonMark), so
  `` `#tag` `` and ``` ``code ` #inner`` ``` are ignored; unpaired backticks
  stay live. The mask replaces the whole span (including delimiters) with
  backtick characters, which is **length-preserving** — match indexes found
  on the masked line apply directly to the original line. Extraction only
  needs the masked text; rename rewriting depends on the preserved offsets.

## Aliases

Documents may carry **aliases** — alternate titles stored in
`document_aliases` (schema v4, [data-model.md](data-model.md)) and managed
by `src/core/aliases.ts` (`kura alias ls|add|rm`, frontmatter, MCP, REST).
They exist for orthographic variants (サーバ/サーバー), abbreviations
(DB設計), and old titles kept resolvable after a rename.

- **Validation** (`normalizeAlias` in `src/core/wiki.ts`): trimmed,
  non-empty, and may not contain `[`, `]`, `|`, `/`, or newlines — an alias
  must be usable inside `[[...]]`, and `/` would collide with full-path
  resolution. Case is **preserved**; all matching is case-insensitive.
- An alias equal to the document's own title (case-insensitive) is silently
  skipped on add, and duplicates are deduped case-insensitively — this keeps
  frontmatter round-trips idempotent. Invalid aliases throw `UsageError`
  from the repository functions; the frontmatter parser drops them instead
  (hand-written files stay importable).
- Aliases participate in wiki-link resolution (stage 3 above), in
  `resolveDoc` (a `<doc>` specifier that matches nothing as a full path or
  title is tried as an alias — unique → resolve, ambiguous →
  `ConflictError`, none → `NotFoundError`; see
  [data-model.md](data-model.md)), and in keyword search (the FTS `aliases`
  column is weighted like the title,
  [search-pipeline.md](search-pipeline.md)).
- Adding an alias self-heals unresolved links that match it; removing one
  re-resolves the links that resolved through it
  ([self-healing.md](self-healing.md)).

## Document paths

Documents carry a slash-separated, folder-like `path` alongside the title
(`documents.path`, `''` = bucket root — schema v2,
[data-model.md](data-model.md)). The notation-relevant rules:

- **The path is a separate column, not part of the title.** A title may
  contain a literal `/` (free text is never split into segments); only the
  `path` column carries hierarchy. On export a `/` in a *title* is sanitized
  to `-`, while path segments become real subdirectories.
- **Normalization** (`normalizeDocPath` in `src/core/wiki.ts`): trim each
  segment, drop empty segments (collapses `//`, strips leading/trailing
  `/`). Unlike tag paths, **case is preserved**.
- `joinDocPath` computes the **full path**
  (`path === '' ? title : path + '/' + title`) — the form wiki links,
  `resolveDoc`, and the repository's uniqueness check match against.

## Hashtags

Syntax: `#tech/db/sqlite`-style tags anywhere in visible body text (`TAG_RE`
in `src/core/wiki.ts`), merged into `document_tags` with `source='manual'`.

- **Character class is Unicode-aware**: each path segment is
  `[\p{L}\p{N}_-]+`, segments joined by `/`. Japanese tags work:
  `#技術/データベース`.
- **Preceding character**: `#` counts as a tag only after line start,
  whitespace, or an opening bracket — including CJK brackets
  `（「『【〔〈《` — via lookbehind. This excludes URL fragments
  (`…/index.html#section`), mid-word hashes (`issue#123`), and `]]#直後`.
- **Headings vs tags**: `# 見出し` (hash + space) never matches because a
  space cannot start the tag character class; `#見出しではなくタグ` at line
  start **is** a tag. A trailing `/` is not part of the tag (`#tech/` →
  `tech`).
- **Normalization** (`normalizeTagPath`): lowercase, trim each segment
  (Unicode whitespace included), drop empty segments (collapses `//`, strips
  leading/trailing `/`). Extraction dedupes on the normalized form, keeping
  first-occurrence order. The same normalizer runs on every other tag input
  path (frontmatter, `--tags`, `kura tag add`), so `tags.path` is always in
  normal form.

## Unresolved links and rename rewriting

- **Write links first, connect later** (SPEC §10.1): saving `[[未来のページ]]`
  before that page exists stores an unresolved row. When a document with a
  matching title **or full path** (case-insensitive, same bucket) is later
  **created, renamed, or moved**, `resolveUnresolvedLinks`
  (`src/core/links.ts`) re-runs the two-stage resolution for those rows
  inside the same save transaction — ambiguous short forms stay unresolved.
  `kura doctor --fix` bulk-resolves the remainder with the same guard
  (`resolveAllUnresolvedLinks` in `src/core/doctor.ts`).
- **Rename / move** (`kura mv` → `updateDocument`): every same-bucket
  referrer with a resolved link to the document gets its body rewritten by
  `replaceWikiLinkTargets` (`src/core/wiki.ts`; plural — it applies several
  replacements in one pass and replaced the old single-replacement helper),
  and the document's own self-links are rewritten too. The rewrite matrix:
  - a **title change** rewrites both `[[旧タイトル]]` and the full-path
    spelling `[[old/full/path]]`; the short form is pointed at the **new
    full path** when the new title alone would be ambiguous in the bucket,
    so it keeps resolving;
  - a **path-only move** rewrites only the full-path spelling — short
    `[[タイトル]]` links keep their `target_id` and stay valid;
  - a **bucket move** rewrites nothing; incoming links unresolve
    ([data-model.md](data-model.md)).

  Only the **title part** of
  `[[旧タイトル]]` / `[[旧タイトル|表示名]]` is replaced (display text is
  preserved); matching is trim + case-insensitive. Code is protected: fenced
  blocks pass through untouched, and inline code is skipped via the
  length-preserving mask — the rewriter finds `LINK_RE` matches on the
  masked line, then splices the replacement text into the *original* line at
  the same offsets. Referrer bodies are saved through `updateDocument`, so
  their derived data re-syncs; `UpdateResult.relinked` reports how many
  referrers changed.

## Frontmatter

Used for import/export round-trips (`kura export` / `kura import`), parsed
and serialized by `src/core/frontmatter.ts`. The block must start at the
first byte (`---` … `---` or `...`); files without one import as body-only.

| Field | Type | On import (omitted ⇒) |
| --- | --- | --- |
| `kura_key` | string, 8-hex | Present + known ⇒ **update** that document; unknown/absent ⇒ create (unknown-but-taken keys are regenerated — see [data-model.md](data-model.md)) |
| `title` | string | Falls back to the file name (`fallbackTitle`) |
| `bucket` | string | `--bucket` flag wins over frontmatter; otherwise config `default_bucket`. Missing buckets are auto-created |
| `path` | string (normalized via `normalizeDocPath`; `""` = explicit bucket root) | Falls back to the file's subdirectory relative to the scanned root, with the leading segment stripped when it equals the bucket name (so an export tree round-trips); direct file arguments ⇒ root |
| `tags` | string array or comma-separated string | No tags. Each entry is normalized (`normalizeTagPath`) and deduped |
| `aliases` | string array or comma-separated string | No change. Invalid entries are dropped (`normalizeAlias`), dedupe is case-insensitive; applied **add-only** on update (like tags). Export emits `aliases: [...]` only when non-empty |
| `favorite` | boolean (`true`/`false`, or the strings `yes`/`no`) | The stored flag is **left alone**. Export writes the key only when the document is pinned, so re-importing an unpinned export never silently unstars anything; an explicit `favorite: false` does unstar |
| `source_url` | string | Kept from the existing document on update; `null` on create |
| `content_type` | `'markdown'` \| `'html'` (anything else ignored) | `'markdown'` |
| `created_at` / `updated_at` | ISO 8601 (anything `Date`-parsable) | `datetime('now')` at save; converted to SQLite format via `toSqliteDatetime`, unparsable values ignored |

- **`kura_key` round-trip**: `serializeFrontmatter` always JSON-quotes the
  key because an unquoted all-digit key (`16052989`) or exponent-like key
  (`12e45678`) would be coerced to a YAML number and break the round-trip.
  The parser additionally rescues hand-written unquoted integer keys
  (`kura_key: 16052989`) by converting safe integers back to strings.
  Regression tests: `tests/documents.test.ts`.
- Export (`src/cli/commands/export.ts`) writes
  `<dir>/<bucket>/<path segments>/<sanitized title>.md` — each path segment
  sanitized like the file name, while a literal `/` in a *title* is
  sanitized to `-` (never nested) — quoting all string scalars, emitting
  `path` only when non-root, `tags` only when non-empty, `favorite` only when
  pinned, `content_type` only when not `markdown`, and timestamps as ISO 8601
  (`toIsoDatetime`).
- **`favorite` is never written as `false`.** That is what makes "key absent ⇒
  leave the flag alone" safe: an export of an unpinned document carries no
  `favorite` key, so re-importing it cannot unstar the document it lands on.
  `kura edit` does not serialize the key at all — favorites are set in the
  browser, and an editor session must not silently drop one.

## `content_type: 'html'` special cases

HTML documents are stored verbatim and mostly opt out of notation handling
(`src/core/documents.ts`):

- **Wiki extraction is skipped** — no links or hashtags are read from an
  HTML body (`syncDerived` substitutes an empty extraction). Tags can still
  be attached via frontmatter, `--tags`, or `kura tag add`.
- **Rename rewriting is skipped** for HTML bodies, both as a referrer and
  for self-links.
- Everything else still applies: HTML content is FTS-indexed and chunked for
  embeddings as plain text, and the browser UI sanitizes it with DOMPurify
  before rendering (`src/client/components/DocContent.tsx`).
- Export emits `content_type: html` so the round-trip preserves the type.

## Deviations from SPEC

- **Code-block exclusion**: SPEC §4 does not mention it; the implementation
  excludes fenced blocks and inline code from link/tag extraction and from
  rename rewriting (a deliberate hardening — `[[x]]` and `#x` inside code
  samples are almost never intended as notation).
- **Hashtag grammar**: SPEC only gives an example (`#tech/db/sqlite`); the
  Unicode character class, preceding-character rule, and heading distinction
  are implementation-defined (locked in by `tests/wiki.test.ts`).
- **`content_type` frontmatter field**: not in SPEC §4's field list; added
  so HTML documents survive the export/import round-trip.
- **`favorite` frontmatter field**: likewise not in SPEC §4; added so the
  browser's sidebar pins survive the round-trip (`.claude/rules/scope.md` R4).
- **Document paths and multi-stage link resolution are additions**: SPEC §4
  resolves `[[Title]]` by title only. The `path` column / frontmatter key,
  the full-path resolution stage, the alias stage, the
  exactly-one-candidate guard, and the ambiguity → unresolved behavior are
  implementation-defined (locked in by `tests/paths.test.ts` and
  `tests/aliases.test.ts`).
- **Aliases are an addition**: SPEC §4 has no alias concept and no
  `aliases` frontmatter field; the `document_aliases` table, `kura alias`,
  and the alias resolution stages are implementation-defined.
- **HTML opt-outs**: SPEC doesn't define how `content_type='html'` interacts
  with wiki syntax; skipping extraction and rename rewriting for HTML is
  implementation-defined.
- **Edge-case semantics** (empty display ⇒ `null`, innermost-bracket wins,
  lowercase-dedupe keeping first occurrence) are defined by the
  implementation and property tests, not by SPEC.
