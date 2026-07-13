# Browser UI

> Covers SPEC §8.3. Key sources: `src/client/**`, `scripts/build-html.ts`,
> `tests/client-build.test.ts`; served by `src/server/http.ts`
> (see [http-api.md](http-api.md)).

The browser UI is a Preact SPA started with `kura browser`. It is a pure
client of the REST API — no server-side rendering, and no state beyond the
URL, `localStorage` (theme, selected bucket) and the one context built on it
(`bucket.tsx`). Everything is bundled into three fixed-name files
(`index.html` / `index.js` / `index.css`) so the compiled binary can embed
them with a static table.

## The selected bucket scopes everything

One bucket is selected at a time, picked in the sidebar and held in
`BucketProvider` (`bucket.tsx`, persisted as `localStorage["kura-bucket"]`).
Every screen — lists, search, the sidebar document and tag trees, the graph,
wiki-link resolution — passes that bucket to the API. **Nothing in the UI
searches or browses across buckets.** Two consequences worth knowing:

- Opening a document that lives in another bucket (direct URL, a wiki link)
  moves the selection to that document's bucket, so the sidebar always
  describes what is on screen (`DocDetail.tsx`).
- The selection resolves against the fetched bucket list: a stored name that
  no longer exists falls back to `main`, then to the first bucket. `Layout`
  holds the screens back until it resolves, so no list is ever rendered
  unscoped.

## File map

| Path (under `src/client/`) | Role |
| --- | --- |
| `index.html` | Static shell: `<div id="app">`, loads `/index.js` + `/index.css`, `lang="ja"` |
| `index.tsx` | Entry point: theme init, wouter route table, 404 |
| `api.ts` | Typed REST client; interfaces mirror `src/server/api.ts` responses (`DocMeta` / `SearchHit` include the document `path`); `resolveDocSpec()` wraps `GET /api/resolve`; `ApiError` carries the HTTP status |
| `bucket.tsx` | `BucketProvider` / `useBucket()` — the selected bucket every screen is scoped to; persisted in `localStorage["kura-bucket"]` |
| `lastdoc.ts` | Remembers the last-read document (`localStorage["kura-last-doc"]`) and rewrites `/` to it before the first render |
| `modal.tsx` | `ModalProvider` / `useModal()` — owns the three modals and the global shortcut handler |
| `shortcuts.ts` | The shortcut table (the list modal is generated from it) and the window `keydown` hook |
| `hooks.ts` | `useAsync()` — the single data-fetching primitive (loading/error/reload, stale-response guard); `useDocumentTitle()` sets `document.title` per screen |
| `markdown.ts` | Rendering pipeline: markdown-it + wikilink rule + highlight.js + DOMPurify; lazy mermaid loader |
| `format.ts` | Date/bytes/percent formatting, `escapeHtml`, `snippetHtml` (`**…**` → `<mark>`) |
| `theme.ts` | Light/dark theme: `data-theme` attribute + `localStorage` |
| `styles.css` | All styling; CSS custom properties per theme |
| `types.d.ts` | Ambient module declarations for the bundler |
| `components/Layout.tsx` | Header (search icon, nav, shortcut help) + sidebar (bucket picker, document tree, tag tree, theme toggle pinned at the bottom); refetches counts on navigation |
| `components/Modal.tsx` | Modal shell: overlay, Escape, focus in on open / restored on close; `ModalHints` renders the `<kbd>` footer |
| `components/SearchModal.tsx` | Raycast-style search: keystroke-by-keystroke keyword search, document / tag tabs, tag filter |
| `components/RecentModal.tsx` | Recently-viewed documents (Ctrl+R) |
| `components/ShortcutsModal.tsx` | The shortcut list (Ctrl+?), generated from `SHORTCUTS` |
| `components/DocContent.tsx` | Body rendering (markdown/html), mermaid activation, internal-link click delegation |
| `components/DocTree.tsx` | Collapsible per-bucket document-path tree; branches toggle, documents link to `/docs/<key>` |
| `components/TagTree.tsx` | Recursive tag hierarchy; links to `/docs?tag=` |
| `pages/Home.tsx` | Reading history (most recently viewed documents) |
| `pages/Stats.tsx` | Statistics + tidying insights (`GET /api/stats`, `GET /api/insights`) |
| `pages/DocList.tsx` | Filterable/paged document table |
| `pages/DocDetail.tsx` | Rendered document + related sidebar |
| `pages/DocEdit.tsx` | Plain editor (title / tags / textarea) |
| `pages/DocByTitle.tsx` | `[[link]]` resolution route (`GET /api/resolve` + search fallback) |
| `pages/Search.tsx` | 3-mode search |
| `pages/Tags.tsx` | Tag browser |
| `pages/Graph.tsx` | d3-force knowledge graph |

## Routing

`wouter-preact` `<Switch>` in `index.tsx`. Order matters: the more specific
`/docs/title/:title` and `/docs/:key/edit` are declared before `/docs/:key`.

| Path | Screen |
| --- | --- |
| `/` | Home — reading history (redirects to the last-read document on a fresh visit) |
| `/docs` | Document list (filters live in the query string: `tag`, `prefix`, `sort`, `stale`, `page`) |
| `/docs/title/:title` | Wiki-link → key resolution (full path or title, wikilink fallback) |
| `/docs/:key/edit` | Editor |
| `/docs/:key` | Document detail |
| `/search` | Search (`q`, `mode`, `tag` in query string) |
| `/tags` | Tag browser |
| `/graph` | Knowledge graph |
| `/stats` | Statistics and tidying insights |
| anything else | 404 page |

The server serves `index.html` for unknown paths (SPA fallback,
[http-api.md](http-api.md)), so deep links work.

Filter/sort/paging state is kept **in the URL**, not component state, so
back/forward and copy-paste of links behave; changing a filter resets `page`.
The **bucket is the exception**: it is app-wide state, not a per-screen
filter, so it lives in the context above rather than in every query string.

Each screen sets `document.title` through `useDocumentTitle()` — the document
name on the detail page, the screen name elsewhere, both suffixed with
`— kura`.

## Screens

- **Home** — the reading history: the 50 most recently *viewed* documents in
  the selected bucket (`sort=accessed`, filtered to those with a
  `last_accessed_at`). It needs no new schema — `documents.last_accessed_at`
  is already bumped by `touchAccess()` on every read, including reads from the
  CLI and MCP, so the list reflects all of kura, not just the browser.
  - **Resume on open.** `bootRedirect()` (`lastdoc.ts`) rewrites `/` to
    `/docs/<last key>` *before the router reads the URL*, so a fresh visit
    lands back where the user left off. Only the bare `/` entry point
    redirects: the logo and the nav still reach the home screen, and a
    document that 404s (deleted) clears the memory so the next boot stops
    redirecting to it.
- **Statistics (`/stats`)** — stat cards from `/api/stats` (documents,
  buckets, tags, chunks, embedding coverage, stale candidates, unresolved
  links, DB size, tokenizer, embedding model), per-bucket document counts,
  and the **tidying insights** from `/api/insights` for the selected bucket:
  unfiled (bucket root), untagged, orphaned (no resolved link either way),
  broken wiki links, and duplicate-looking tags. Each card shows the count,
  names the CLI command that fixes it, and expands to the list. This screen
  never mutates anything — staleness and gardening surface review candidates;
  nothing is auto-deleted or auto-merged (see
  [self-healing.md](self-healing.md)).
- **Document list** — table with a hierarchical tag filter (descendants
  included, matching the API), document-path filter (`prefix`, also
  descendant-inclusive), sort selector, stale-only checkbox, 20 per page
  with prev/next pagination against `total`. Titles render with a muted
  `path/` prefix when the document has one. There is no bucket column or
  dropdown — the sidebar picker scopes the whole table.
- **Document detail** — rendered body (pipeline below); a path breadcrumb
  above the title (each segment links to `/docs?prefix=`); header
  with edit / delete (confirm dialog) actions; right sidebar with metadata
  (bucket, access count, created/updated, source URL), tag chips,
  **backlinks**, and **two-hop links grouped by the shared target**, all
  from `/api/docs/:key/related`.
- **Editor** — deliberately plain (SPEC §8.3): title input, comma-separated
  tags input, `<textarea>` body, save/cancel. Save issues `PUT
  /api/docs/:key` with the full tag array (diff-sync contract — see
  [http-api.md](http-api.md)). A richer editor is roadmap
  ([roadmap.md](roadmap.md)).
- **Search page (`/search`)** — mode toggle (キーワード / ベクトル /
  ハイブリッド) and a tag filter, `limit=30`, always within the selected
  bucket. Renders API `warnings` (degraded mode) above results; each hit
  shows title, source badge, score, snippet with `<mark>` highlights, and tag
  chips. This is the *full* search; the modal below is the fast path.
- **Sidebar document tree** — a sidebar section rendering
  `GET /api/docs/tree` for the selected bucket. Built by
  `buildDocTree` in core (mirrors `buildTagTree`): branch nodes come from
  path prefixes and toggle open/closed (component state, default closed);
  document nodes link to the detail page; a branch whose path is itself a
  document does both. Titles containing a literal `/` stay single leaves.
- **Tag browser** — the selected bucket's tag tree with "direct / total
  including descendants" counts; every node links to the filtered document
  list. Tags no document in the bucket uses do not appear.
- **Knowledge graph** — see below.
- **Link resolution (`/docs/title/:title`)** — calls `GET /api/resolve`
  (`resolveDocSpec()` in `api.ts`) with the raw link text — full path or
  unique title, the same `resolveDoc` grammar as the CLI — and redirects to
  the detail page on success (`replace: true` so history stays clean). A 404
  (not created yet) or 409 (ambiguous) falls back to a keyword search and
  shows an "unresolved link" page listing the closest matches with their
  full paths — the click-through target for red wikilinks.

## Modals and keyboard shortcuts

`ModalProvider` (`modal.tsx`) sits inside the router, owns which modal is open
and hosts the single window `keydown` listener (`useShortcuts`). The header's
magnifier icon opens the same search modal the shortcut does.

| Shortcut | Action |
| --- | --- |
| `Ctrl + K` | Search modal |
| `Ctrl + ?` | Shortcut list |
| `Ctrl + R` | Recently viewed documents |
| `Ctrl + H` | Home |
| `Ctrl + T` | Tag browser |
| `Escape` | Close the modal |
| `↑` `↓` `Enter` | Move / choose inside a modal |

**Why Ctrl and not Cmd.** On macOS the browser and the OS own Cmd+T (new
tab), Cmd+H (hide app) and Cmd+R (reload); a page cannot take them back, and
stealing Cmd+R would cost the user reload. Ctrl+letter is effectively free
there. On Windows / Linux the browser still owns Ctrl+T — a known limitation,
stated in the shortcut list rather than worked around.

Two rules keep the handler out of the user's way, and both matter for
Japanese input:

- **Composition is never a shortcut.** `e.isComposing` (and `keyCode === 229`)
  short-circuits the handler, so keystrokes that belong to an IME conversion
  cannot fire an action — including `Enter`, which confirms a conversion.
- **Typing wins.** With focus in an input, textarea, select or contenteditable,
  every shortcut except `Escape` is ignored.

The **search modal** is the fast path: keyword mode only, scoped to the
selected bucket, with the query debounced 150 ms and re-issued against
`/api/search` on every keystroke. It reuses the server pipeline deliberately —
the vaporetto morphological tokenizer, BM25 ranking and `**…**` snippets have
no client-side equivalent, and the API is on localhost, so a round trip reads
as instant. (A client-side index — DuckDB-WASM and friends — was considered
and rejected: tens of MB in a binary that must stay self-contained
[`scope.md` R6], and no way to reproduce Japanese tokenization.) Two tabs:
documents, and tags — the tag list is small, so it is fetched once per bucket
and filtered in the browser. Choosing a tag sets it as the document filter
rather than navigating away. Vector and hybrid search stay on `/search`.

## Rendering pipeline

Implemented in `src/client/markdown.ts` and applied by
`components/DocContent.tsx`.

```
markdown-it (html: true, linkify) 
  → wikilink inline rule ([[Title]] / resolution via env)
  → highlight.js (curated language set, fenced code)
  → DOMPurify.sanitize()          ← always the final step
  → dangerouslySetInnerHTML
  → mermaid blocks upgraded lazily in the DOM
```

- **markdown-it** is configured with `html: true` (raw HTML allowed *because*
  DOMPurify runs afterwards) and `linkify: true`; GFM tables are on by
  default. Fenced code is highlighted with a hand-picked highlight.js
  language set (registering `highlight.js/lib/core` + individual languages
  keeps the bundle small). `mermaid` fences are deliberately *not*
  highlighted so they stay findable as `code.language-mermaid`.
- **Wikilinks**: an inline rule registered before `link` parses `[[Title]]`
  (rejecting empty titles, newlines, and nested `[`). The renderer consults
  `env.resolve` (a `WikiResolver`): resolved titles become
  `<a class="wikilink" href="/docs/<key>">`, unresolved ones become
  `<a class="wikilink wikilink-unresolved" href="/docs/title/<title>">`
  (rendered red) pointing at the resolution route above. `DocDetail` builds
  the resolver from the already-fetched related outlinks, so no extra
  request is needed. The `[[Title|display text]]` form from SPEC §4 is not
  rendered specially (see Deviations).
- **Sanitization invariant**: every string that reaches
  `dangerouslySetInnerHTML` **must pass through DOMPurify** —
  `renderMarkdown()` sanitizes its own output, `sanitizeHtml()` covers
  `content_type = "html"` documents, and search snippets go through
  `snippetHtml()` (escape first, then insert `<mark>` only). Never
  interpolate server data into HTML by any other route.
- **Mermaid**: `DocContent` watches `code.language-mermaid` blocks with an
  `IntersectionObserver` and upgrades each block only when it scrolls into
  view. `loadMermaid()` imports `mermaid@11` from the jsdelivr CDN — the
  dynamic import goes through `new Function("u", "return import(u)")` so
  Bun's bundler does not try to resolve the URL. This CDN fetch is **the
  only external network resource in the entire UI** (and it is initiated by
  the user's own browser, on demand); everything else is bundled. On load
  failure or diagram syntax errors the plain code block is kept — no error
  UI, no retry loop. Mermaid runs with `securityLevel: "strict"` and picks
  its theme from the kura theme at first load.
- **Internal navigation**: rendered HTML is inert, so `DocContent` delegates
  clicks — a left-click on an `<a href="/...">` without modifier keys is
  intercepted and routed through wouter instead of a full page load.

## Theming

`theme.ts` stamps `data-theme="light" | "dark"` on `<html>`:

1. `initTheme()` (run before first render) prefers `localStorage["kura-theme"]`,
   falling back to `prefers-color-scheme`.
2. The toggle — an icon-only button (`lucide-preact` Sun / Moon) pinned to the
   bottom of the sidebar — calls `setTheme()`, which persists the choice.
3. All colors are CSS custom properties on `:root` /
   `:root[data-theme="dark"]` in `styles.css`; a
   `@media (prefers-color-scheme: dark)` block targeting
   `:root:not([data-theme])` covers the instant before JS runs (and no-JS).
   highlight.js token colors are custom properties too, so both themes share
   one stylesheet.

### Brand color

kura's accent is **Hanada (縹 / Japan Blue)** — an indigo drawn from the
world of the Edo-period white-plastered storehouse (蔵) the name evokes. It
deepens to a saturated blue on the light "plaster" ground and lightens on the
dark "sumi (墨)" ground so it stays legible on both.

| Token | Light (`#`) | Dark (`#`) | Role |
|---|---|---|---|
| accent | `#275c86` | `#64abda` | primary accent — buttons, links, active nav, the wordmark |
| accent-text | `#ffffff` | `#10131a` | text/foreground placed **on** the accent |

The same brand hue is applied across every kura surface, each defining it in
its own token vocabulary:

| Surface | File | Light accent | Dark accent |
|---|---|---|---|
| Browser UI | `src/client/styles.css` (`--accent` / `--accent-text`) | `#275c86` | `#64abda` |
| Docs site | `docs/src/styles/custom.css` (`--sl-color-accent`; `-low` / `-high` shades) | `#275c86` (low `#d8e8f4`, high `#1d465f`) | `#64abda` (low `#123246`, high `#a8d3ec`) |
| Favicons | `docs/public/favicon.svg` | block `#275c86`, lattice `#cfe6f5` | — |
| Marp deck | `docs/marp/kura-v0.1.ja.md` | `#275c86` (headings, accents) | — |

When retheming, change the accent in each surface's own token block — there is
no shared source file across surfaces, so the four files above are the canonical
list to keep in sync.

## Knowledge graph implementation

`pages/Graph.tsx` uses **only `d3-force`** (no d3-selection/zoom/drag —
keeping the dependency surface small) and renders plain SVG DOM:

- Nodes/edges come from `/api/graph` (optionally bucket-filtered). The
  "孤立ノードを表示" checkbox includes/excludes `degree === 0` nodes; edges are
  re-filtered so both endpoints exist.
- **Color = top-level segment of the node's first tag**, palette assigned in
  descending frequency order; untagged nodes are gray. A legend is rendered
  from the same assignment.
- Node radius grows with `degree` (`4 + √degree × 2.5`); labels render for
  every node on small graphs (≤ 120 nodes), otherwise only for `degree ≥ 2`;
  every node gets a `<title>` tooltip.
- **Stale nodes are dimmed** via the `stale` class (opacity in CSS), matching
  the staleness surfaced on Home.
- Zoom (wheel, 0.2×–5×, cursor-anchored), pan (background drag), and node
  drag (fixing `fx`/`fy` while dragging, with `alphaTarget` reheat) are
  **hand-rolled pointer-event handlers** on the SVG — hit-testing finds the
  nearest node within its radius. A click that never moved more than 3 px
  navigates to the document detail.
- `setupGraph()` returns a cleanup function (stop simulation, remove
  listeners, clear the SVG); the effect re-runs on data/toggle changes.

Two-hop links are *not* drawn in the graph (direct links only); that is
explicit future work ([roadmap.md](roadmap.md)).

## Build pipeline

`bun run build:client` → `scripts/build-html.ts`:

1. `Bun.build` bundles `src/client/index.tsx` (target `browser`, minified,
   no sourcemaps) into `dist/` with **fixed, hash-free names**
   (`naming: "[dir]/[name].[ext]"`).
2. The CSS artifact is normalized to `dist/index.css` (renamed if Bun emitted
   another name; copied straight from `styles.css` if Bun emitted none).
3. `index.html` is copied verbatim, and the script fails loudly if any of the
   three artifacts is missing.

Hash-free names matter because `scripts/compile.ts` embeds `dist/*` into the
single binary by generating `src/generated/embedded.ts` (URL path → embedded
file path, via `with { type: "file" }` imports) and the server's embedded
resolver looks paths up verbatim. In development the generated module stays a
stub (empty table) and assets are served from `dist/`; `compile.ts` restores
the stub after building. Details in
[build-and-release.md](build-and-release.md); serving order in
[http-api.md](http-api.md).

`tests/client-build.test.ts` guards the pipeline: it runs the real build,
then serves `dist/` through `startServer` and asserts content types and the
SPA fallback.

## UI language policy

**All user-visible strings in `src/client/` are intentionally Japanese** —
kura is a Japanese-first knowledge tool, and the browser UI is one of the two
sanctioned Japanese surfaces (the other being LLM prompt templates); see
`CLAUDE.md`. Do not "fix" UI strings into English. Code comments,
identifiers, and CSS class names stay English.

## Deviations from SPEC

- **The `/docs/title/:title` route and `GET /api/resolve` are additions.**
  SPEC §8.3 only asks for `[[リンク]]` to become clickable; the
  implementation resolves link text server-side via `resolveDoc` (full path
  / unique title — [http-api.md](http-api.md)) and gives unresolved or
  ambiguous links a landing page with near-match suggestions.
- **`[[Title|display text]]` is not special-cased** in the renderer: the raw
  inner text (including the `|display`) is used as both label and lookup key,
  whereas SPEC §4 defines the pipe form. Core extraction handles it; the
  browser renderer currently does not split it.
- **The editor also edits title and tags**, not just the body ("textarea +
  save" in SPEC §8.3) — a benign extension riding on the PUT contract.
- **Graph node coloring** is by *top-level segment of the first tag* with a
  frequency-ordered palette; SPEC just says "colored by tag".
- **Mermaid via CDN** matches SPEC §8.3 ("Mermaid lazy-loaded") but note it
  is the product's only runtime external resource beyond the sanctioned list
  in `CLAUDE.md`; it is browser-initiated, lazy, and fails closed to a plain
  code block.
- **The selected bucket is app-wide state, not a per-screen filter.** SPEC
  §8.3 sketches a bucket dropdown on the list and search screens; the UI
  instead picks one bucket in the sidebar, persists it, and scopes every
  screen to it. Cross-bucket browsing and search were dropped deliberately:
  a bucket is a workspace, and results that straddle two of them were noise.
  This is also the single exception to "no state outside the URL".

## Related docs

- [http-api.md](http-api.md) — every endpoint this UI calls
- [document-notation.md](document-notation.md) — wikilink/hashtag semantics
- [build-and-release.md](build-and-release.md) — embedding into the binary
- [self-healing.md](self-healing.md) — staleness definition surfaced here
