# Roadmap

> Covers SPEC §15. Future work explicitly out of v1 scope — designed around,
> but not implemented.

These items were considered during the v1 design so that implementing them
later does not require breaking changes. None of them are commitments.

- **Rich editor in the browser UI** (CodeMirror). v1 ships a plain
  `<textarea>` editor on purpose; the PUT `/api/docs/:key` contract already
  carries everything a richer editor needs.
- **`kura watch`** — auto-import via filesystem watching. v1 deliberately has
  no implicit ingestion; everything enters through `add` / `import` / `clip` /
  MCP. A watcher would reuse `importDocument` (frontmatter round-trip).
- **2-hop links in the graph view and tag pages** (tag pages where a tag
  itself has a description). The 2-hop SQL already exists in
  `src/core/links.ts`; the graph currently renders direct links only.
- **Homebrew tap distribution.** The release workflow already produces
  per-platform ZIPs; a tap formula would wrap them.
- **Query-expansion model fine-tuning.** The expansion
  prompt lives in `src/core/search/expand.ts` behind the `llm_cache`, so a
  tuned model would slot in via config without pipeline changes.
- **Scale beyond ~10k documents** (quantization, partitioning) is a declared
  non-goal for v1; sqlite-vec brute-force KNN is sufficient at the target
  scale (see [performance.md](performance.md)).

## Related docs

- [architecture.md](architecture.md) — current layering these items build on
- [search-pipeline.md](search-pipeline.md) — where expansion/reranking hook in
