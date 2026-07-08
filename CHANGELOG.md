# Changelog

All notable changes to this project will be documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Initial implementation: document CRUD with buckets, hierarchical tags, and
  `[[wiki links]]` (unresolved links auto-resolve when the target page is
  created, following the Cosense model).
- Japanese-aware hybrid search: FTS5 BM25 keyword search
  ([sqlite-vaporetto](https://github.com/hotchpotch/sqlite-vaporetto)
  morphological tokenizer with trigram fallback), semantic KNN search
  ([sqlite-vec](https://github.com/asg017/sqlite-vec) + local embeddings), and
  RRF fusion with local-LLM yes/no reranking. The search pipeline follows the
  architecture of [qmd](https://github.com/tobi/qmd).
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
