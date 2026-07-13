# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Browser UI: documents are now edited where they are read. The rendered
  document is editable in place — headings, lists, quotes, bold/italic/code and
  links, with Markdown shortcuts (`# `, `- `, `1. `, `> `, ` ``` `) and a
  selection toolbar — and saves itself 1.5 s after you stop typing (`Ctrl + S`
  saves at once). Code blocks, tables and raw HTML keep a text editing surface
  behind a rendered preview. Tags are added and removed in the sidebar, which
  also lists documents sharing a tag or a path. The separate `/docs/:key/edit`
  editor is gone (the URL redirects to the document); clipped HTML documents
  stay read-only.
- Browser UI: a search modal (`Ctrl + K`, or the magnifier next to the logo)
  that searches as you type, with separate document and tag tabs and a tag
  filter. Keyboard shortcuts: `Ctrl + K` search, `Ctrl + ?` shortcut list,
  `Ctrl + R` recently viewed, `Ctrl + H` home, `Ctrl + T` tags. The header
  search box is gone. (Ctrl rather than Cmd: macOS reserves Cmd+T / Cmd+H /
  Cmd+R.)
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
  replaces them.

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
