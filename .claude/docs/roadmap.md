# Roadmap

> Covers SPEC §15. Future work explicitly out of v1 scope — designed around,
> but not implemented.

These items were considered during the v1 design so that implementing them
later does not require breaking changes. None of them are commitments.

- **`kura watch`** — auto-import via filesystem watching. v1 deliberately has
  no implicit ingestion; everything enters through `add` / `import` / `clip` /
  MCP. A watcher would reuse `importDocument` (frontmatter round-trip).
- **2-hop links in the graph view and tag pages** (tag pages where a tag
  itself has a description). The 2-hop SQL already exists in
  `src/core/links.ts`; the graph currently renders direct links only.
- **Query-expansion model fine-tuning.** The expansion
  prompt lives in `src/core/search/expand.ts` behind the `llm_cache`, so a
  tuned model would slot in via config without pipeline changes.
- **Synonym expansion via the Sudachi synonym dictionary.** Document
  aliases (schema v4) cover per-document orthographic variants; a general
  synonym layer (サーバ/サーバー across the whole store) could expand FTS
  queries from a bundled dictionary (Apache-2.0, license-compatible).
  Deliberately deferred: fetching the dictionary is new network access, so
  scope.md R1 makes it a design discussion, not a chore commit. A local
  synonym table consulted at query-build time (`src/core/search/keyword.ts`)
  would need no schema change.
- **Scale beyond ~10k documents** (quantization, partitioning) is a declared
  non-goal for v1; sqlite-vec brute-force KNN is sufficient at the target
  scale (see [performance.md](performance.md)).

## Related docs

- [architecture.md](architecture.md) — current layering these items build on
- [search-pipeline.md](search-pipeline.md) — where expansion/reranking hook in
