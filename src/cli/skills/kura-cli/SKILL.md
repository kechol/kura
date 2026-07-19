---
name: kura-cli
description: >-
  Operate kura, a local Japanese-first knowledge base, from the command line:
  save notes and web clips, search it (keyword / semantic / hybrid), read and
  organize documents (buckets, document paths, hierarchical tags,
  [[wiki links]]), and export/import Markdown. Use when the user mentions
  kura, asks to save something into or look something up in their local
  knowledge base, or wants their stored notes searched or organized.
---

# kura CLI operations

kura stores Markdown/HTML documents in one SQLite database (`~/.kura/kura.db`,
override with `KURA_DB`; home dir with `KURA_HOME`). Japanese-aware hybrid
search is its core feature. Everything below works offline; LLM-dependent
features degrade gracefully (see "Degraded operation").

## Essentials

- Pass `--json` to read commands for machine-readable output
  (`status`, `get`, `ls`, `search`, `vsearch`, `query`, `ask`, `add`,
  `config list`, `bucket ls`, `tag ls`, `link ls`, `alias ls`,
  `history`, `changes`, `audit`, `triage`).
- Starting a session? `kura changes --since 7d --json` lists what was
  created or updated since you last looked (renames and moves included;
  deletions are not tracked).
- Exit codes: `0` ok, `1` error, `2` usage, `3` not found,
  `4` LLM provider unavailable.
- `<doc>` arguments accept a doc key (`a1b2c3d4` or `#a1b2c3d4`), a full
  document path (`clips/タイトル`), a title unique within a bucket, or a
  unique alias; disambiguate with `--bucket`.
- Non-interactive use: `kura rm` needs `--force` when stdin is not a TTY.
  Avoid `kura edit` (opens `$EDITOR`); to update a document
  programmatically, `kura export` it, modify the file, and `kura import` it
  back — a frontmatter `kura_key` updates the existing document in place.

## Core concepts

- **bucket** — top-level grouping. Default: config `general.default_bucket`.
- **document path** — optional slash-separated namespace (`clips/技術`);
  `''` is the bucket root, a first-class inbox (filing is never required).
- **hierarchical tag** — `技術/データベース/SQLite`; tag filters include
  descendants.
- **wiki link** — `[[タイトル]]` (or `[[full/path/タイトル]]` to pin one
  document, `[[タイトル|表示名]]` for display text) inside bodies; `kura mv`
  rewrites them on rename/move.
- **alias** — alternate title (`kura alias add <doc> <alias>`): `[[別名]]`
  links resolve to the document and keyword search matches it. Use for
  orthographic variants (サーバー/サーバ) and abbreviations.
- **doc key** (`kura_key`) — stable 8-hex identity used by
  `get` / `export` / `import`.
- **revision** — every content / title / path change keeps the replaced
  state. `kura history <doc>` lists (`rN` ids), `kura history restore
  <doc> <rN>` brings a body back (content only, itself undoable), and
  `kura get <doc> --as-of 2026-03-01` reads a past state.

## Searching — pick deliberately

- `kura search "<query>"` — keyword FTS5 BM25. Fast, exact terms, no LLM.
  `--all` = AND search.
- `kura vsearch "<query>"` — semantic vector KNN. Requires an embedding
  provider (Ollama / LM Studio); exits 4 without one.
- `kura query "<query>"` — hybrid RAG: FTS + vector fused with RRF, then
  reranked; `--expand` adds LLM query expansion. Falls back to keyword-only
  with a warning when no provider is reachable.
- `kura ask "<question>"` — answers the question from the top hybrid hits
  with cited sources (`[1]`, `[2]`, …). Falls back to plain search results
  without a provider. `--json` →
  `{answer, sources: [{n, key, path, title, bucket}], hits}`.

Start with `search` when the user knows the words, `query` for vague recall
returning documents, `ask` when the user wants an answer rather than a hit
list. All four accept `--bucket`, `--tag`, `--limit`, `--json`.
A search result row (`--json`) has
`{key, title, bucket, tags, score, snippet, source}` — follow up with
`kura get <key>` to read the document (and to verify `ask` citations).

## Command reference

Save:

```sh
kura add <file>... [--bucket b] [--path p] [--tags t1,t2] [--title T] [--type markdown|html]
echo "本文..." | kura add - --title "タイトル" [--tags 技術/DB]
kura clip <url> [--bucket b] [--tags t1,t2] [--no-llm] [--dry-run] [--force]
```

Read:

```sh
kura get <doc> [--raw|--pretty|--json] [--lines A:B] [--bucket b] [--as-of T]
kura ls [--bucket b] [--tag t] [--prefix p] [--sort updated|created|accessed|title|views] [--stale] [--unfiled] [--untagged] [--limit n] [--json]
kura link ls <doc> [--json]     # outgoing links + backlinks
kura history <doc> [--json]     # revision list; also: show <doc> <rN>, restore <doc> <rN>
kura changes --since 7d [--bucket b] [--limit n] [--json]   # created/updated since a point in time
kura status [--json]            # counts, tokenizer, embedding coverage, triage backlog
```

Organize:

```sh
kura mv <doc> [<new-title>] [--path <new-path>] [--bucket b]   # relinks [[references]]
kura mv --prefix <old-prefix> <new-prefix>                     # move a whole subtree
kura tag ls [--tree] | add <doc> <tag>... | rm <doc> <tag>... | mv <old> <new> | gc
kura alias ls <doc> | add <doc> <alias>... | rm <doc> <alias>...
kura bucket ls | add <name> [--desc t] | rm <name> [--force] | mv <old> <new>
kura rm <doc> --force [--bucket b]
```

Triage the backlog (the "dump first, organize later" workflow):

```sh
kura triage [<doc>...] [--bucket b] [--limit n] [--steps dedupe,title,tags,path,links] [--apply] [--json] [--redo]
kura audit [contradictions|dupes|tags|links] [--bucket b] [--limit n] [--apply] [--json]
```

`kura triage` walks the backlog — documents at the bucket root or without
tags, not yet triaged (or edited since the last pass) — and proposes, per
document, duplicate merges, a better title, tags, a document path, and
related `[[links]]`. On a TTY it confirms each step (`[y/e/n/s/q]`: `s`
skips the rest and marks the doc triaged, `q` quits); `--apply` applies
everything except duplicate merges (never automatic); `--json` is a dry
run. It **never exits 4** — without a provider it falls back to structural /
keyword signals and skips the LLM-only steps (title, tags, dupe verdicts)
with a warning.

`kura audit` runs knowledge-base health checks: `links` (unresolved wiki
links), `tags` (tag merge candidates + oversized tags), `dupes` (exact +
near-duplicate documents), `contradictions` (LLM-judged conflicting
passages). Bare `kura audit` runs all four report-only. Only
`kura audit contradictions` requires a provider (**exit 4**); the others
degrade with a warning. `--apply` on `dupes` / `tags` confirms each fix
interactively.

Bulk / backup (the portability story — Markdown with frontmatter):

```sh
kura export --dir <path> [--bucket b] [--tag t]
kura import <dir|file>... [--bucket b]
```

Maintenance:

```sh
kura doctor [--fix]        # diagnose / repair extensions, FTS, links, embeddings
kura embed [--all]         # generate (or regenerate) chunk embeddings
kura config list | get <key> | set <key> <value>
kura init [--no-download]  # first-time setup
```

`--json` shapes for the triage/audit commands (stable contracts):

- `kura triage --json` → `[{key, title, steps, warnings}]`; `steps` carries
  only the steps that ran — `dedupe.candidates[]`, `title` (`{proposed,
  reason}` or null), `tags[]`, `path` (`{path, source, reason?}` or null),
  `links[]`.
- `kura audit contradictions --json` →
  `{examined_pairs, contradictions: [{a, b, similarity}]}` where `a` / `b`
  are `{key, title, path, bucket, excerpt}`.
- `kura audit dupes --json` → `{exact: [[{key, title}], …], near: [{a, b,
  similarity, verdict?}]}`.
- `kura audit tags --json` → `{merges: [{from, to, reason, similarity}],
  oversized: [{path, count, share}]}`.
- `kura audit links --json` → `[{target_title, sources}]`.
- Bare `kura audit --json` → `{links, tags, dupes, contradictions?}`
  (the `contradictions` key is omitted when no provider is reachable).

## Recipes

Save a quick note:

```sh
echo "WAL モードでは reader と writer が並行できる。" | \
  kura add - --title "SQLite の WAL モード" --tags 技術/データベース
```

Find, then read:

```sh
kura search "WAL モード" --json    # → pick .key from the results
kura get a1b2c3d4 --raw
```

Update a document without an editor:

```sh
kura export --dir /tmp/kura-out --bucket main
# modify /tmp/kura-out/main/.../タイトル.md (keep the kura_key frontmatter)
kura import /tmp/kura-out
```

## Degraded operation

kura guarantees keyword search, CRUD, links and tags with **no LLM provider
and no vaporetto tokenizer**. Without a provider: `vsearch` and
`audit contradictions` exit 4, `query` falls back to keyword-only, `ask`
shows search results instead of an answer, `clip` still works (`--no-llm`
skips LLM formatting entirely), and `kura triage` / `kura audit` (`tags`,
`dupes`) drop their LLM steps and suggest from structural / keyword signals
only. Without the vaporetto extension, FTS falls back to a trigram
tokenizer (`kura doctor --fix` re-fetches it).

## MCP alternative

If the host supports MCP, `kura mcp` exposes the same operations as MCP
tools over stdio (`kura mcp --print-config` prints setup snippets). The CLI
remains the fully scriptable path.

<!-- Generated by `kura skills install` (kura {{KURA_VERSION}}). Reinstalling overwrites this file. -->
