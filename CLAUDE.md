# CLAUDE.md

kura is a local knowledge management CLI that stores Markdown/HTML documents in
SQLite and serves both humans (CLI, browser UI) and AI agents (MCP server,
`--json` output). Japanese-aware hybrid search is the core feature: FTS5 with
the sqlite-vaporetto morphological tokenizer, sqlite-vec KNN with local
embeddings, and local-LLM reranking.

Detailed documentation lives in **`.claude/docs/`** — start at its
[README](.claude/docs/README.md).

## Commands

```sh
bun run dev -- <args>     # run the CLI from source (e.g. bun run dev -- doctor)
bun test                  # full test suite
bun test tests/foo.test.ts
KURA_TEST_DOWNLOAD=1 bun test tests/db.test.ts   # includes the real vaporetto download+load test
bun run check             # tsc --noEmit + biome check
bun run build:client      # build the SPA into dist/
bun run compile           # single binary for the current platform (scripts/compile.ts)
```

Tests use in-memory or temp-dir databases (`KURA_HOME` / `KURA_DB` env vars).
Never point tests at the real `~/.kura`.

## Architecture

- `src/core/` — all domain logic. The repository layer (`documents.ts`) keeps
  `documents_fts` / `links` / `document_tags` / `chunks` in sync inside a
  single transaction. **There are no SQL triggers; never UPDATE `documents`
  directly** — go through the repository functions.
- `src/cli/` — one command per file under `commands/`, registered in
  `index.ts` with lazy imports. Exit codes: 0 ok, 1 error, 2 usage,
  3 not found, 4 LLM provider unavailable (`src/core/errors.ts`).
- `src/server/` — REST API (`api.ts`), Bun.serve wiring (`http.ts`), MCP
  server (`mcp.ts`). Handlers must reuse `src/core/`; no logic duplication.
- `src/client/` — Preact SPA, bundled by `scripts/build-html.ts`, embedded
  into the compiled binary via `src/generated/embedded.ts` (a stub in dev;
  `scripts/compile.ts` regenerates and restores it).
- On macOS, `Database.setCustomSQLite()` (Homebrew SQLite) must run before the
  first `Database` is created or extension loading crashes — always open
  connections through `src/core/db.ts`.

Degraded operation is a hard requirement: every LLM-dependent feature must
work (with a warning) when no provider is reachable, and FTS falls back to the
trigram tokenizer when vaporetto is unavailable. Tests for LLM features use a
mock `LLMProvider` (`setProviderForTests`), never a live server.

## Documentation

Topic docs live in `.claude/docs/` — one document per subsystem, indexed in
`.claude/docs/README.md`. Rules that keep them useful:

- **Docs change with the code.** A change to user-facing behavior, schema,
  protocols, CLI surface, or invariants updates the matching document in the
  same commit. Code comments cite documents as `docs: <name>.md`, meaning
  `.claude/docs/<name>.md`.
- New subsystems get a new document plus an index row in
  `.claude/docs/README.md`.
- The source code is the source of truth. The original design spec (the
  baseline the docs grew from, cited as `SPEC §N` inside them) lives in git
  history; where the implementation diverges from it, the doc records the
  divergence under "Deviations from SPEC" — don't silently rewrite history.

Two more agent-facing surfaces sit next to the docs:

- **`.claude/rules/`** — prescriptive rules Claude Code auto-loads each
  session (or when a matching file is opened). `.claude/docs/` is
  descriptive (what the system *is*); `.claude/rules/` is prescriptive
  (what you may not change). When a rule and a doc disagree, the rule
  wins. Indexed in `.claude/rules/README.md`.
- **`.claude/skills/`** — repo skills. `/docs` syncs the documentation
  with the code (read-only on code, never commits); `/release` opens a
  version-bump PR. User docs live under `docs/` (Astro Starlight,
  English root + Japanese `ja/` mirror), published to
  <https://kechol.github.io/kura/>; a Japanese intro deck lives in
  `docs/marp/`.

## Language conventions

- Code comments, docs, commit messages, CLI output, and MCP tool descriptions
  are **English**.
- **CJK test data must stay Japanese.** Fixture documents
  (`tests/fixtures/docs/`), search queries, titles, tags, and content
  assertions exist to prevent regressions in Japanese tokenization, BM25
  ranking, snippets, and chunking. Translating them would silently gut the
  tests. English-only search tests are not acceptable (docs: testing.md).
- Two intentional Japanese surfaces in the product: the browser UI strings
  (`src/client/`) and the LLM prompt templates (clip formatting, tag
  suggestion, query expansion, answer generation) — kura is a Japanese-first
  knowledge tool and the prompts are tuned for Japanese content. Keep the
  surrounding comments in English.
- README is bilingual: `README.md` (English) and `README.ja.md` (Japanese).
  Update both when user-facing behavior changes.

## This is a public OSS project

The repo is published under MIT OR Apache-2.0 (dual-licensed). **Every commit,
PR, issue comment, and CHANGELOG line is public** the moment it lands on
`origin/main` (or any pushed branch). Treat the repo accordingly.

- **No private context.** No internal URLs, employer-specific paths,
  customer names, sandbox endpoints, personal data, or secrets in
  source / commits / PR descriptions / issue replies. `gitleaks` runs
  in pre-commit but its allowlist is not exhaustive — be intentional.
- **No "leaked context" via comments.** Comments and commit messages
  must not reveal what someone said in a private conversation, what
  is on the user's screen, or anything sourced from
  `TODO.md` / `.prompt` (gitignored, local-only).
- **External-friendly tone.** PR titles, commit subjects, issue
  comments, error messages, and user-facing strings should read well
  to a stranger who lands here from a Google search. Avoid in-jokes,
  internal shorthand, or aggressive language.
- **No telemetry, no phoning home.** kura is a local tool. The only
  permitted network access is: (1) the SHA256-pinned sqlite-vaporetto
  download from GitHub Releases during `kura init` / `kura doctor --fix`,
  (2) build-time prebuilt fetches from the npm registry
  (`scripts/fetch-vendor.ts`), (3) localhost LLM providers
  (Ollama / LM Studio), (4) the user-initiated `kura clip <url>`
  fetch, and (5) the browser UI's lazy mermaid load from
  cdn.jsdelivr.net (browser-side, only when a document contains a
  mermaid block; fails soft offline). Don't add HTTP clients beyond
  these, version-check pings, or analytics. Anything new on this
  list is a design discussion.
- **Attribution.** When borrowing an algorithm or pattern from a
  paper / blog post / other OSS project, cite it in code comments
  and / or `CHANGELOG.md`. Don't paste code from incompatible
  licenses.
- **Dependencies have license consequences.** Runtime and bundled
  dependencies must be MIT/Apache-2.0/BSD/ISC-compatible (they are
  compiled into the distributed binary). There is no automated license
  gate yet, so check before adding: a non-MIT-compatible dep is a
  license discussion, not a chore commit.
