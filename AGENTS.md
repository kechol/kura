# AGENTS.md

kura is a local SQLite knowledge management CLI with a browser UI and MCP
server. Japanese-aware hybrid search combines FTS5/sqlite-vaporetto,
sqlite-vec embeddings, and local-LLM reranking.

## Working agreement

Make routine implementation decisions autonomously. Preserve user changes and
public contracts; stay within scope. Review and planning requests do not
authorize fixes.

Finish the requested change, affected documentation, and relevant checks.
Local builds and tests with disposable fixtures may run within runtime
permissions without repeated approval. Fix failures caused by your changes
and rerun affected checks. Respect task-specific completion criteria;
documentation-only changes do not need the application test suite.

Ask when missing information materially changes the outcome or an action needs
authorization. Continue independent work while blocked. Commit only when
requested. Pushes, PRs, external messages, releases, and paid services require
explicit authorization. Never bypass hooks.

User instructions take precedence over repository and skill guidance within
runtime permissions. If guidance blocks work, identify the exact instruction
and explain the conflict rather than inventing an approval requirement.

Report the outcome concisely in the user's language, including verification
results and material limitations. Distinguish passed checks from unrun checks.

## Task-specific references

Read only what the task needs. Use the [subsystem index](.claude/docs/README.md)
for implementation details. Codex must read applicable shared rules explicitly;
Claude Code's automatic loading does not apply:

| Task | Rules |
| --- | --- |
| Product scope, persistence, networking, distribution | [scope.md](.claude/rules/scope.md) |
| Code and data changes | [invariants.md](.claude/rules/invariants.md) |
| Tests and fixtures | [testing.md](.claude/rules/testing.md) |
| Naming and Japanese text | [terminology.md](.claude/rules/terminology.md) |
| Behavior changes, commits, releases | [workflow.md](.claude/rules/workflow.md) |

Rules take precedence over descriptive docs; code establishes actual behavior.
Correct stale docs with the change and surface conflicts with protected contracts.
Use `.claude/skills/docs/` for documentation sync and `.claude/skills/release/`
for an authorized release PR. Tagging and publication follow maintainer approval.

## Commands and test boundaries

```sh
bun run dev -- <args>     # CLI from source
bun test                 # full offline suite; append a test path to narrow it
bun run check            # TypeScript + Biome
bun run build:client     # SPA build
bun run compile          # single binary for the current platform
```

Tests use in-memory or temporary databases via `KURA_HOME` / `KURA_DB`, never
the real `~/.kura`. Mock LLM providers with `setProviderForTests`; cover the
no-provider path. Keep CJK fixtures, queries, titles, tags, and assertions
Japanese to protect tokenization, ranking, snippets, and chunking. English-only
search tests are insufficient. Real vaporetto download/load testing is opt-in:
`KURA_TEST_DOWNLOAD=1 bun test tests/db.test.ts`.

## Core constraints

- Domain logic belongs in `src/core/`; CLI, REST, and MCP reuse it. Document
  mutations go through `src/core/documents.ts`, synchronizing derived tables
  in one transaction. There are no SQL triggers to repair direct writes.
- Open connections through `src/core/db.ts`: macOS custom SQLite setup must
  precede the first connection. Append migrations; never edit shipped ones.
  Read tokenizer and embedding identity from database `meta`.
- Preserve CLI/JSON/MCP contracts and typed-error exit codes: 0 success,
  1 error, 2 usage, 3 not found, 4 LLM unavailable.
- Missing LLM providers warn and skip or fall back; missing vaporetto falls
  back to trigram FTS. Keyword search, CRUD, links, and tags remain usable.
  sqlite-vec is required and reports a doctor hint if loading fails.

## Documentation and commits

Use `kura` and its canonical terms consistently. Keep source comments, internal
guidance, `README.md`, English docs, CLI output, and MCP descriptions in English.
`README.ja.md` and Japanese user docs mirror English pages in natural Japanese.
Browser UI strings and LLM prompts stay Japanese. Comments explain why; user
docs address newcomers.

CLI, JSON, schema, and naming changes include affected tests, English/Japanese
docs, bundled skills, internal references, and a `CHANGELOG.md` Unreleased entry
in the same change. Apply schema bumps and breaking notes where required.
Update subsystem docs for behavior and invariant changes; index new subsystems.
Comments cite `.claude/docs/` pages as `docs: <name>.md`. Preserve historical
`Deviations from SPEC` notes.

Write commit subjects and bodies in English. Follow Conventional Commits and
explain the reason and key decisions in the body. When IDs exist, use one-line
`Task:`, `Decision:`, or `Supersedes:` trailers; do not invent IDs.

## Public OSS boundaries

Keep source and public communications free of secrets, personal data, internal
URLs, and private context.
Attribute borrowed work. Runtime and bundled dependencies must be compatible
with the project's MIT OR Apache-2.0 licensing; check before adding them.

kura has no telemetry or update pings. Product network access is limited to
SHA256-pinned vaporetto downloads during init/doctor repair, build-time npm
prebuilt fetches, localhost LLM providers, user-initiated URL clipping, and lazy
browser Mermaid loading from `cdn.jsdelivr.net` with offline fallback. Expanding
this allowlist requires an explicit design decision; see the scope rules.
