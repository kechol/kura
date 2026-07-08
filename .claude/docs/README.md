# kura documentation

Topic-focused documentation for contributors and Claude Code sessions.
**The source code is the source of truth**, and these docs explain the code —
its invariants, trade-offs, and the reasons behind them.

Code comments cite these documents as `docs: <name>.md`, meaning
`.claude/docs/<name>.md`. References to `SPEC §N` (in the "Covers" notes and
"Deviations from SPEC" sections below) point to the original v1 design
specification, which these documents replaced; it remains available in git
history (`SPEC.md`, removed after the docs restructure).

## Documents

| Document | Covers |
| --- | --- |
| [architecture.md](architecture.md) | Layers, module map, data flow, core invariants, non-goals (SPEC §1, §12) |
| [data-model.md](data-model.md) | Schema, consistency rules, migrations, meta keys, doc keys (§3) |
| [document-notation.md](document-notation.md) | Wiki links, hashtags, frontmatter round-trip, rename semantics (§4) |
| [search-pipeline.md](search-pipeline.md) | Search modes, hybrid pipeline, chunking, embedding backfill (§5) |
| [llm-providers.md](llm-providers.md) | Provider abstraction, detection, models, caching, degradation (§6) |
| [cli-reference.md](cli-reference.md) | Global CLI conventions and every command in detail (§7) |
| [native-extensions.md](native-extensions.md) | sqlite-vec / sqlite-vaporetto loading, platforms, fallbacks (§2) |
| [http-api.md](http-api.md) | REST endpoints, server behavior, ports and binding (§8.1–8.2) |
| [browser-ui.md](browser-ui.md) | SPA structure, pages, rendering pipeline, UI language policy (§8.3) |
| [mcp-server.md](mcp-server.md) | MCP tools, schemas, agent guidance, testing (§9) |
| [self-healing.md](self-healing.md) | doctor checks and fixes, link resolution, gardening, staleness (§10) |
| [configuration.md](configuration.md) | config.toml, environment variables, meta interplay (§11) |
| [build-and-release.md](build-and-release.md) | Dev workflow, single-binary pipeline, release workflow (§12) |
| [testing.md](testing.md) | Test policy, CJK data requirements, mock provider, e2e patterns (§14) |
| [performance.md](performance.md) | Targets and measured results (§13) |
| [roadmap.md](roadmap.md) | Future work explicitly out of v1 scope (§15) |

## Conventions for these docs

- **English**, concise, written for someone changing the code tomorrow.
  Explain invariants and *why*, don't paste long code excerpts — link to
  files with repo-relative paths instead (e.g. `src/core/documents.ts`).
- Each document starts with a one-line scope note: which SPEC § it covers
  and which source files are authoritative for it.
- Japanese sample strings appear where they illustrate CJK behavior; see
  `CLAUDE.md` for the three intentionally-Japanese surfaces.
- **Keep docs in sync with behavior changes.** A PR that changes user-facing
  behavior, schema, protocols, or invariants updates the matching document
  in the same commit. New subsystems get a new document plus a row in the
  table above.
- Where the implementation deviates from the original SPEC baseline, the
  document says so explicitly (a "Deviations from SPEC" note) instead of
  silently rewriting history.
