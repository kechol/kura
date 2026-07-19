---
name: docs
description: Sync kura's documentation with the current code. Reads every tracked Markdown / MDX page under `docs/src/content/docs/` (Astro Starlight site, English root + Japanese `ja/` mirror), the internal docs and rules under `.claude/docs/` and `.claude/rules/`, `.claude/skills/**/SKILL.md`, the shipped agent-skill template `src/cli/skills/**/SKILL.md`, `CLAUDE.md`, and `README.md` / `README.ja.md`, compares each claim against the live source tree (`src/`, `--help` output, `src/server/mcp.ts` schemas, `src/core/migrations/`), and rewrites stale or missing sections in place — preserving voice and structure, sweeping English + Japanese in lockstep. Read-only on code; writes only to doc files. Does NOT commit and never touches `CHANGELOG.md` (owned by `/release`). Trigger on "/docs", "update the docs", "sync docs with code", "docs are stale, fix them", "rewrite outdated docs", "freshen the documentation".
---

# docs

Walk every doc surface in this repo, find what disagrees with the current
code, rewrite it in place. Read-only on code, write-only on docs. Never
commits (workflow.md R4).

Two audiences, two languages, one pass:

- **User docs** — `docs/src/content/docs/**`, `README.md` /
  `README.ja.md`. Newcomer audience. English root, Japanese mirror.
- **Internal docs** — `.claude/docs/**`, `.claude/rules/**`,
  `.claude/skills/**/SKILL.md`, `CLAUDE.md`. Contributor / AI-agent
  audience. Always English (workflow.md R7). Capture decision rationale.
- **Shipped agent skill** — `src/cli/skills/**/SKILL.md` (the `kura-cli`
  guide embedded into the binary and installed by `kura skills install`).
  External-agent audience. English body, Japanese example content. Its
  command usages, `--json` shapes, and exit codes must match the CLI
  exactly — treat every claim like a reference page.

## Drift to look for

1. **Renamed identifier** — CLI flag, `--json` key, MCP tool, config
   key, command name moved in code; docs cite the old spelling.
2. **Removed surface** — a subcommand, flag, MCP tool, or config key is
   gone; docs still mention it.
3. **New surface, undocumented** — landed in code, never made it into
   docs (new command in `src/cli/commands/`, new MCP tool, new config
   key, new migration).
4. **Wrong shape** — `--json` payloads, config TOML, schema / `meta`
   keys, exit codes, HTTP routes diverged from `src/`.
5. **en / ja parity drift** — English page updated, Japanese mirror
   didn't; or a canonical name got translated (command names, config
   keys, code identifiers must stay verbatim — terminology.md R4).
6. **Bit-rotted examples** — printed command output / TOML / file trees
   no longer match what the binary produces. Re-run, paste new.

Fix the smallest region containing the drift. A 90%-right page gets a
10% rewrite, not a tone overhaul.

## When NOT to use

- A brand-new page from scratch — propose first, align on placement /
  audience / voice, then create English + Japanese in one pass.
- `CHANGELOG.md` — owned by `/release`; never touch it here.
- Pure prose polish with no code drift — Goodhart applies to docs too;
  don't rewrite for its own sake.

## Output language

Identifiers stay verbatim across all surfaces — command names
(`kura query`), `--json` keys, MCP tool names (`kura_query`), config
keys (`default_bucket`), `meta` keys (`fts_tokenizer`), file paths,
env vars (`KURA_HOME`).

Per-file language (workflow.md R7):

| Path | Language |
|---|---|
| `README.md`, `CLAUDE.md` | English |
| `README.ja.md` | Japanese |
| `CHANGELOG.md` | Don't touch — owned by `/release` |
| `docs/src/content/docs/*.md(x)` (root) | English |
| `docs/src/content/docs/ja/**` | Japanese (native) |
| `.claude/docs/**`, `.claude/rules/**`, `.claude/skills/**/SKILL.md` | English |
| `src/cli/skills/**/SKILL.md` | English body; keep the Japanese example commands/content Japanese |

Japanese mirror prose must read native (terminology.md R4): translate
**meaning** not structure; keep canonical names verbatim; no ASCII
spaces around CJK characters in prose; prefer 「〜できます」 over
「〜することができます」; drop pronouns; neutral 丁寧語 only.

## Pre-flight

Refuse to start when the repo is mid-merge or has conflict markers —
surface and bail. A dirty worktree is **not** a blocker (the user
reviews the diff before committing); print `git status` once so they can
see what was already in flight.

If the user passed scope ("ja only", "README only", "internal only"),
narrow accordingly. No scope → sweep everything.

## Phase 1 — Inventory

```sh
git ls-files \
  'README.md' 'README.ja.md' 'CLAUDE.md' \
  'docs/src/content/docs/**/*.md' 'docs/src/content/docs/**/*.mdx' \
  '.claude/docs/**/*.md' '.claude/rules/**/*.md' \
  '.claude/skills/**/SKILL.md' 'src/cli/skills/**/SKILL.md'
```

Skip `CHANGELOG.md` (owned by `/release`). For each page, the frontmatter
plus the first ~100 lines is enough to triage; pull the full body only
when triage flags drift.

## Phase 2 — Snapshot the code

Build a current-state map of the things docs claim, from source, not from
memory. Use the **Explore subagent** for breadth — spawn it once with a
list of questions, get a structured answer back, use that as the source
of truth for diffing.

Where each claim category lives:

| Claim | Source |
|---|---|
| CLI subcommands, flags | `bun run dev -- --help` and per-subcommand `bun run dev -- <cmd> --help`; `src/cli/index.ts`, `src/cli/commands/` |
| Exit codes | `src/core/errors.ts` (`UsageError`=2, `NotFoundError`=3, other=1, `LLMUnavailableError`=4) |
| `--json` output shapes | Types in `src/core/*.ts`; the command's `--json` branch under `src/cli/commands/` |
| MCP tools + schemas | `src/server/mcp.ts` |
| HTTP endpoints | `src/server/api.ts` |
| Schema, `meta` keys, migrations | `src/core/migrations/`, `src/core/db.ts` (`PRAGMA user_version`, `MIGRATIONS`, `meta`) |
| Config keys + defaults | `src/core/config.ts` |
| Search pipeline stages | `src/core/search/`, `.claude/docs/search-pipeline.md` |
| Native-extension behavior | `src/core/bootstrap.ts`, `.claude/docs/native-extensions.md` |

Capture the snapshot as terse notes. Don't paste large code blocks into
chat — the notes are for your own diff reasoning.

## Phase 3 — Diff each doc against the snapshot

For each Phase-1 file, ask:

1. **Identifiers** — every cited command, flag, `--json` key, MCP tool,
   config key, env var exists in the snapshot with the same spelling.
2. **Coverage** — for reference pages (CLI, config, MCP), every snapshot
   entry has at least one mention.
3. **Shape** — printed `--json`, TOML, file trees, command output match
   what the binary produces today. Re-run if in doubt.
4. **Audience** — internal jargon (`documents_fts`, `chunks_vec`,
   "repository layer") leaking into user docs is drift (scope.md R7);
   a user-doc summary hiding the precise contract that belongs in
   `.claude/docs/` is also drift.
5. **en / ja parity** — for every English page under
   `docs/src/content/docs/*.md(x)`, the `ja/` mirror at the same path
   exists, covers the same headings in the same order, and keeps
   canonical names verbatim. `README.md` ↔ `README.ja.md` likewise.
6. **Tone** — internal docs terse and precise; user docs plain and
   welcoming; Japanese mirror native (terminology.md R4).

Build a per-file change list before any write. Example shape:

```
README.md
  L48  install snippet: ZIP-only → add `brew install kechol/tap/kura`
  L96  MCP tool list missing kura_related

docs/src/content/docs/cli.md
  Add `kura embed` row; refresh the exit-code table

docs/src/content/docs/ja/cli.md
  Mirror the above; sweep CJK spacing on the touched lines

.claude/docs/mcp-server.md
  kura_query params: `k` renamed to `limit`
```

Pages with zero drift: note and move on.

## Phase 4 — Apply minimal rewrites

Edit one file at a time. Default unit is the smallest contiguous region
containing the drift, not the whole section.

Preserve, in priority order: frontmatter (`title`, `description`,
sidebar keys — touch only if the title itself is wrong); heading
hierarchy (reorganization breaks deep links); voice and length (terse
stays terse, chatty stays chatty); working examples (leave them; paste
new output only when it actually differs).

By surface:

- **Internal docs** — state the current contract precisely. When a
  behavior changed, add a one-line **why**.
- **User docs** — explain user benefit, not mechanism. Reaching for
  `documents_fts` / `chunks_vec` / "repository layer" → redirect to
  `.claude/docs/` with a one-sentence user summary.
- **SKILL.md bodies** — the `description` frontmatter is the trigger
  contract; keep it trigger-rich and externally readable. Body changes
  follow the minimal-region rule.

## Phase 5 — Sweep en / ja parity

Every change to an English page is mirrored to
`docs/src/content/docs/ja/<same-path>` (and `README.md` → `README.ja.md`)
in the same pass (workflow.md R3). The split-into-follow-up-PR pattern is
the bug, not the cure.

Verification loop after Japanese edits — the artifact is a stray space
**between two Japanese tokens** (a space between a Latin/code token and
Japanese is intentional in this repo, terminology.md R4):

```sh
# space between two Japanese characters (mechanical-translation artifact)
rg -n '[぀-ヿ一-鿿] [぀-ヿ一-鿿]' docs/src/content/docs/ja README.ja.md
```

Hits inside `` `code spans` `` are fine; hits in prose are drift — fix
and re-run until clean.

## Phase 6 — Tone and voice review

After all edits, re-read each touched file end-to-end (not diff-only):

- **Internal docs** — every claim sourced; rationale present where a
  contract changed; no marketing language.
- **User docs** — a newcomer arriving from a web search can follow each
  page; no internal jargon outside the architecture page.
- **README** — install snippet runs as written; the command list matches
  `src/cli/index.ts`; the MCP tool list matches `src/server/mcp.ts`; doc
  links resolve.
- **Japanese mirrors** — read aloud in your head. Common smells:
  「〜することができます」 where 「〜できます」 fits; stray pronouns;
  過剰敬語; machine-translation spaces.

Re-run the Phase-5 verification once more on whatever you changed here.

## Final output

One block per touched file:

```
README.md
  +2 -1   install section now lists `brew install kechol/tap/kura`

docs/src/content/docs/cli.md
  +9 -2   added `kura embed`; refreshed exit-code table

docs/src/content/docs/ja/cli.md
  +9 -2   same as cli.md; CJK spacing sweep on L22, L47

.claude/docs/mcp-server.md
  +4 -3   kura_query `k` → `limit`
```

Then, in one or two lines, surface drift you spotted but deliberately did
**not** fix (out of scope, ambiguous, needs the user's call).

End with: changes are unstaged. The user runs `git diff` to review and
commits when ready.

## Constraints

- Read-only on code; never modify outside the Phase-1 doc set. The one
  file under `src/` in that set is `src/cli/skills/**/SKILL.md` — it is
  a doc surface (an embedded Markdown template), not code; keep its
  `{{KURA_VERSION}}` placeholder intact.
- Never touch `CHANGELOG.md` (owned by `/release`).
- No `git add`, `git commit`, push, or PR (workflow.md R4).
- No new top-level docs without asking — propose first, then create both
  English and Japanese in one pass.
- Don't write Japanese in `.claude/**` or leave English-only paragraphs
  in `ja/**`.
- Code is the source of truth. If a `.claude/docs/` claim and the code
  disagree, fix the doc (workflow.md R5).
