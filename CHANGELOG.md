# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Keyboard-only operation of the browser UI, following the Gmail / GitHub
  conventions. Single keys alias the Ctrl combos (`/` search, `c` new
  document, `?` shortcut list) and collide with nothing the browser owns;
  `g`-prefixed sequences reach every screen (`g h` home, `g d` documents,
  `g t` tags, `g g` graph, `g s` statistics, `g r` recent, `g b` bucket
  picker). The list screens gain a `j` / `k` cursor with `Enter` or `o` to
  open (`h` / `l` turn pages on the document list; the recent-docs modal
  accepts `j` / `k` too), and the document screen gains
  `e` (edit), `s` (favorite), `u` (back to list) and `#` (delete). `Escape`
  now leaves the editor, cancels a title edit, and closes a raw block's text
  editor. The shortcut modal (`?`) lists all of them, grouped by screen.

- Document aliases — alternate titles for a document, backed by schema v4
  (a `document_aliases` table, migrated automatically). `[[alias]]` wiki
  links resolve to the document (and self-heal when an alias is added
  later), `kura get` and every `<doc>` reference accept a unique alias,
  and keyword search matches aliases at title weight. Manage them with
  `kura alias ls|add|rm`, the frontmatter `aliases:` key (round-tripped by
  `kura export` / `kura import`), the `aliases` parameter on the
  `kura_add` / `kura_update` MCP tools, the `aliases` field in the REST
  document JSON (`PUT /api/docs/:key` diff-syncs the set), or the 別名 row
  in the browser's document sidebar. Useful for orthographic variants
  (サーバー/サーバ) and abbreviations.
- `kura ask` — answer a question from the knowledge base with cited
  sources. Runs the hybrid search, then the local generation model answers
  strictly from the top 5 hits, citing them as `[1]`, `[2]`, …; answers are
  cached in `llm_cache` and invalidated when a cited document changes. Also
  exposed as the `kura_ask` MCP tool. Without an LLM provider (or on a
  generation failure) it degrades to plain search results with a warning.
- Document revision history — backed by schema v5 (a `document_revisions`
  table, migrated automatically). Every content, title, or path change
  snapshots the replaced state in the same save transaction; autosave
  bursts coalesce into one revision per burst and the newest 100 per
  document are kept. `kura history <doc>` lists revisions,
  `kura history show <doc> <rN>` prints one, `kura history restore` brings
  a body back (content only, itself undoable), and `kura get --as-of`
  reads a document as it was at any past time.
- `kura changes --since` — a change feed for agents (and humans) catching
  up: documents created or updated since a point in time, newest first,
  with renames and moves detected against the revision history. `--since`
  accepts relative times (`30m` / `24h` / `7d` / `2w`) or a date. Also
  exposed as the `kura_changes` MCP tool, meant to be called at session
  start. Deletions are not tracked. Works fully without an LLM provider.
- `kura audit` — contradiction detection. Semantically close passages from
  the most recently updated documents are paired via embedding KNN, and
  the local generation model judges each pair (yes/no) for contradictory
  statements; verdicts are cached until either side's text changes.
  Requires a reachable LLM provider (exit 4 otherwise).
- `kura skills` — manage an agent skill that teaches AI coding agents to
  drive kura from the CLI. `kura skills install` writes `kura-cli/SKILL.md`
  into `~/.agents/skills` (any skills directory via `--dir`), `uninstall`
  removes it, and `show` prints it to stdout. The skill ships inside the
  binary and is stamped with the kura version on install.

### Fixed

- Browser UI: `[[Title|display text]]` wiki links now render the display
  text and resolve by the title, instead of showing the raw text with the
  pipe.

### Changed

- Browser UI: the document reading surface was redesigned around Japanese
  editorial typography — a reading column of about 49 full-width characters
  that the document panel hugs (no stretching across wide windows),
  larger body type with taller leading and slight tracking,
  proportionally-set (`palt`) headings, always-underlined links, hairline
  tables, and a print stylesheet. The in-place editor shares the same metrics,
  so a document renders identically while reading and editing. Fixes a
  horizontal overflow of the document panel on narrow screens caused by long
  unbreakable strings.
- Browser UI: flat surface pass — the header and sidebar now sit on the page
  ground so documents are the only paper-white panels, decorative card shadows
  are gone (elevation is reserved for the search modal and floating toolbar),
  corner radii and hover washes are unified into design tokens, and the light
  theme ground is a touch warmer.

## [0.2.0] - 2026-07-19

### Added

- Favorite documents: star a document from its title row and it stays pinned in
  the sidebar on every screen, above the document tree. A favorite is rooted at
  its own full path, so whatever is filed under it expands beneath it as a
  collapsible tree. Backed by schema v3 (a `favorite` column, migrated
  automatically), `PUT /api/docs/:key/favorite` and `GET /api/docs?favorite=1`.
  Starring is not an edit — it leaves `updated_at` alone. `kura export` writes
  `favorite: true` in the frontmatter and `kura import` restores it.
- Browser UI: the document path is editable from the detail page — click the
  path in the sidebar's メタ情報 box, with completions from the paths already
  in use. Moving a document rewrites `[[links]]` in referring documents, the
  same as `kura mv --path`.
- Browser UI: documents are now edited where they are read. The rendered
  document is editable in place — headings, lists, quotes, bold/italic/code and
  links, with Markdown shortcuts (`# `, `- `, `1. `, `> `, ` ``` `) and a
  selection toolbar — and saves itself 1.5 s after you stop typing (`Ctrl + S`
  saves at once). Code blocks, tables and raw HTML keep a text editing surface
  behind a rendered preview. Tags are added and removed in the sidebar, which
  also lists documents sharing a tag or a path. The separate `/docs/:key/edit`
  editor is gone (the URL redirects to the document); clipped HTML documents
  stay read-only.
- Browser UI: a search modal (`Ctrl + P`, or the magnifier next to the logo)
  that searches as you type, with separate document and tag tabs and a tag
  filter. Keyboard shortcuts: `Ctrl + P` search, `Ctrl + N` new document,
  `Ctrl + ?` shortcut list, `Ctrl + R` recently viewed, `Ctrl + H` home,
  `Ctrl + T` tags. The header search box is gone. (Ctrl rather than Cmd: macOS
  reserves Cmd+T / Cmd+H / Cmd+R / Cmd+N / Cmd+P.)
- Browser UI: `Ctrl + N` creates an untitled document in the selected bucket
  and opens it with the title selected, ready to be typed over. New endpoint
  `POST /api/docs` (retries a taken title as "title (2)").
- Browser UI: opening kura resumes the last document you were reading, and
  the home screen is now the reading history (50 most recently viewed
  documents in the selected bucket).
- Browser UI: a statistics screen (`/stats`) with the old dashboard numbers
  plus tidying insights for the selected bucket — unfiled, untagged and
  orphaned documents, broken wiki links, and duplicate-looking tags — each
  naming the CLI command that fixes it. Backed by `GET /api/insights`;
  needs no LLM provider.
- Browser UI: the sidebar now picks one bucket for the whole app, and every
  screen — lists, search, the document and tag trees, the graph, wiki-link
  resolution — is scoped to it. The choice persists across restarts; opening
  a document from another bucket follows the selection there.
- `GET /api/tags` accepts `bucket` to count tags within a single bucket.
- Browser UI: the tab title now names the current document or screen.
- Browser UI: a collapsible per-bucket document tree in the sidebar
  (`GET /api/docs/tree`), a document-path filter on the list page
  (`prefix`, also on `GET /api/docs`), and a path breadcrumb on the
  detail page.
- `kura mv suggest`: a filing assistant that proposes paths for unfiled
  (bucket-root) documents from link / tag / keyword signals, semantic
  neighbors, and an LLM pick with a reason when a provider is reachable;
  interactive by default, with `--apply` and `--json` modes. Works
  without any provider (signal layers degrade gracefully).
- Hierarchical document paths: documents can carry an optional
  slash-separated path (`kura add --path db/sqlite`), browsable with
  `kura ls --prefix` and movable with `kura mv <doc> --path` or in bulk with
  `kura mv --prefix <old> <new>` (rewrites `[[links]]` in referring
  documents).
- `[[full/path/Title]]` wiki links pin a single document; `GET /api/resolve`
  resolves key / full path / unique title for the browser UI.
- `kura export` writes paths as real subdirectories and `kura import`
  derives paths from subdirectories when frontmatter has none, so exported
  trees (and Obsidian-style folder trees) round-trip.
- New config key `clip.path` (default `"clips"`): `kura clip` files clips
  under a dedicated path.

### Changed

- **BREAKING**: title uniqueness is now per (bucket, path, title) — schema
  v2, migrated automatically (existing documents land at the bucket root,
  ids and links preserved). Equal titles can coexist under different paths,
  so title-based addressing and `[[Title]]` links resolve only when the
  title is unique in scope; ambiguous references are reported
  (`kura link broken`, `kura doctor`) instead of silently picking one.
- **BREAKING**: `--json` output of `ls` / `get` / `add`, REST document and
  search-hit payloads, and MCP tool results now include a `path` field;
  `kura_add` / `kura_update` accept an optional `path` parameter.
- `kura clip` no longer fails on a duplicate title — it retries as
  "タイトル (2)", "タイトル (3)", ….
- Browser UI: the theme toggle moved from the header to the bottom of the
  sidebar and is now an icon (`lucide-preact`). The per-screen bucket
  dropdowns and the bucket column on the list are gone — the sidebar picker
  replaces them. The shortcut-list icon has since joined it there, and the
  document's delete button moved out of the title row to the bottom of the
  document sidebar, where it now says what it deletes and stays muted until
  you hover it.

## [0.1.0] - 2026-07-08

### Added

- Initial implementation: document CRUD with buckets, hierarchical tags, and
  `[[wiki links]]` (unresolved links auto-resolve when the target page is
  created).
- Japanese-aware hybrid search: FTS5 BM25 keyword search
  ([sqlite-vaporetto](https://github.com/hotchpotch/sqlite-vaporetto)
  morphological tokenizer with trigram fallback), semantic KNN search
  ([sqlite-vec](https://github.com/asg017/sqlite-vec) + local embeddings), and
  RRF fusion with local-LLM yes/no reranking.
- Local LLM provider abstraction with Ollama-first auto detection and
  LM Studio fallback; every LLM feature degrades gracefully when no provider
  is reachable.
- `kura clip`: web page capture via Mozilla Readability, LLM Markdown
  cleanup with turndown fallback, and existing-tag-first tag suggestions.
- Self-healing: `kura doctor --fix` (index rebuild, orphan GC, link
  re-resolution, embedding-model change detection), tag gardening
  (`tag suggest` / `tag audit`), and staleness scoring.
- MCP server (`kura mcp`) exposing 8 tools for AI agents; `--json` output on
  all read commands.
- Browser UI (`kura browser`): Preact SPA with document viewer, backlinks and
  2-hop links, three-mode search, tag browser, and a d3-force knowledge graph.
- Single-binary distribution via `bun build --compile` for five targets, with
  embedded SPA assets and sqlite-vec extension.
