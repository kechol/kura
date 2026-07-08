# kura — Local Knowledge Management CLI Specification

> **This file is an index.** The original v1 specification was decomposed
> into topic documents under [`.claude/docs/`](.claude/docs/README.md), which
> are richer than the original text and track the implementation (including
> explicit "Deviations from SPEC" notes). The source code is the source of
> truth; these documents explain it.
>
> Code comments cite this specification as `SPEC §N`. The table below maps
> every section of the original document to the topic document that now
> covers it. The full original text remains available in git history.

## What kura is

kura stores Markdown/HTML documents in a single local SQLite database and
makes them queryable by humans (CLI, browser UI) and AI agents (MCP server,
`--json` output). Settled design principles:

- **SQLite is the source of truth** — document bodies live in the DB; files
  are only import/export material.
- **One global DB** (`~/.kura/kura.db`, overridable via `KURA_HOME` /
  `KURA_DB`), sized for ~10k documents (brute-force KNN, no ANN).
- **Japanese-aware hybrid search** — FTS5 + sqlite-vaporetto morphological
  tokenization (trigram fallback), sqlite-vec KNN with local embeddings,
  local-LLM reranking. Ollama is auto-detected first, then LM Studio; every
  LLM feature degrades gracefully to keyword-only operation.
- **Self-organizing knowledge** — no folder hierarchy; buckets + hierarchical
  tags (`tech/db/sqlite`) + wiki links (`[[Title]]`) in the Cosense style,
  with self-healing (link auto-resolution, index repair, tag gardening,
  staleness review).
- **Single-binary distribution** built with Bun.

Non-goals for v1: multi-user/sync/cloud features, filesystem watching,
100k+ document scale, WYSIWYG editing.

## Section map

| SPEC § | Topic | Document |
| --- | --- | --- |
| §1 | Overview, design principles, non-goals | [architecture.md](.claude/docs/architecture.md) |
| §2 | Technology stack, extension loading, platforms | [native-extensions.md](.claude/docs/native-extensions.md) |
| §3 | Data model, schema, consistency rules | [data-model.md](.claude/docs/data-model.md) |
| §4 | Document syntax (wiki links, tags, frontmatter) | [document-notation.md](.claude/docs/document-notation.md) |
| §5 | Search pipeline, chunking, embedding backfill | [search-pipeline.md](.claude/docs/search-pipeline.md) |
| §6 | LLM provider abstraction | [llm-providers.md](.claude/docs/llm-providers.md) |
| §7 | CLI command specification | [cli-reference.md](.claude/docs/cli-reference.md) |
| §8.1–8.2 | Browser server and REST API | [http-api.md](.claude/docs/http-api.md) |
| §8.3 | Browser UI screens | [browser-ui.md](.claude/docs/browser-ui.md) |
| §9 | MCP server | [mcp-server.md](.claude/docs/mcp-server.md) |
| §10 | Self-healing and knowledge health | [self-healing.md](.claude/docs/self-healing.md) |
| §11 | Configuration | [configuration.md](.claude/docs/configuration.md) |
| §12 | Project structure, build, distribution | [architecture.md](.claude/docs/architecture.md), [build-and-release.md](.claude/docs/build-and-release.md) |
| §13 | Performance and quality targets | [performance.md](.claude/docs/performance.md) |
| §14 | Testing policy | [testing.md](.claude/docs/testing.md) |
| §15 | Future extensions (out of v1 scope) | [roadmap.md](.claude/docs/roadmap.md) |

## Keeping documentation in sync

The rules live in [CLAUDE.md](CLAUDE.md) and
[.claude/docs/README.md](.claude/docs/README.md): behavior changes update the
matching topic document in the same commit; new subsystems get a new document
plus index rows here and in the docs README; divergences from this baseline
are recorded in each document's "Deviations from SPEC" section rather than by
rewriting history.
