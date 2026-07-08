---
description: Repo-specific commit, PR, doc-co-update, and release rules for kura. Generic Bun/biome/tsc hygiene is enforced by CI; only the repo-specific items are listed here.
---

# Workflow rules

Generic hygiene (`bun run check` = `tsc --noEmit` + `biome check`,
`bun test`) is enforced by CI. The rules below are the repo-specific
items CI does not catch.

## R1. Conventional Commits with `!` for breaking

```
<type>(<scope>): <imperative summary, ≤72 chars>
<type>!(<scope>): <subject>            # breaking
```

Types in active use: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`,
`ci`, `build`, `perf`. The `/release` skill reads these to compute the
next semver and generate the CHANGELOG.

The trailing `!` marks any user-visible contract change: CLI flag rename,
`--json` field rename, schema-version bump, removed command, MCP tool
signature change.

## R2. Renames sweep in the same PR

A rename (CLI flag, `--json` key, MCP tool name, config key) is one PR.
The sweep covers source under `src/`, tests under `tests/`, the MCP
schema, the affected `.claude/docs/` page, the Astro user docs (en +
`ja` mirror), `README.md` / `README.ja.md`, and `CHANGELOG.md`. Never
split into "code PR + docs sweep PR" — the follow-up sweep is the bug,
not the cure.

## R3. Doc co-update is part of the change PR

When a CLI flag, `--json` shape, schema field, config key, MCP tool, or
HTTP endpoint changes, the same PR includes:

- Source change + test update.
- The matching `.claude/docs/` document (docs change with the code —
  `CLAUDE.md`). Code comments cite it as `docs: <name>.md`.
- The Astro user docs (`docs/src/content/docs/`) **and** the Japanese
  mirror (`docs/src/content/docs/ja/`) when user-facing behavior moved.
- `README.md` **and** `README.ja.md` when the README covers it.
- `CHANGELOG.md` "Unreleased" entry (breaking flagged).

Forgetting docs == PR not ready.

## R4. Don't commit unless the user asks

Make changes, stop, summarize. The user reviews diffs and commits when
ready. Don't chain a commit onto a task automatically. (Background jobs
in an isolated worktree are the documented exception — see the harness
instructions — but never push to `main` or force-push.)

## R5. Code is the source of truth; both doc trees follow it

`.claude/docs/` (descriptive) and `.claude/rules/` (prescriptive) both
describe the code. When either disagrees with the code, the code wins and
the doc is fixed in the same PR. A rule that is itself wrong gets fixed in
its own PR — don't code around a stale rule silently.

## R6. Don't bypass hooks (`--no-verify` etc.)

If a pre-commit hook fails, fix the underlying issue. If the hook itself
is broken, fix the hook in its own PR. `gitleaks` runs pre-commit; a
false positive is allowlisted deliberately, not skipped with
`--no-verify`.

## R7. Language split

| Surface | Language |
|---|---|
| `README.md`, `CHANGELOG.md`, `docs/src/content/docs/*` (root) | English |
| `README.ja.md`, `docs/src/content/docs/ja/*` | Japanese (mirror) |
| `.claude/docs/`, `.claude/rules/`, `CLAUDE.md` | English |
| Source comments (`.ts`, `.sql`, shell, TOML) | English |
| CLI output, MCP tool descriptions | English |

Two intentional Japanese surfaces in the product: the browser UI strings
(`src/client/`) and the LLM prompt templates (clip formatting, tag
suggestion, query expansion). Keep the surrounding comments English. See
`CLAUDE.md` for the full policy and `terminology.md` for the CJK-test-data
rule.

When updating Japanese pages, watch for unnatural ASCII spaces around CJK
characters — a common mechanical-translation artifact
(`コードベース を 観測` is wrong). See `terminology.md` R4.

## R8. Release flow

`/release` opens the version-bump PR. After it merges, the maintainer
manually tags the merge commit:

```sh
git switch main && git pull
git tag v0.x.y
git push origin v0.x.y
```

Tagging triggers `.github/workflows/release.yml` (cross-compile,
GitHub Release, Homebrew formula push) and `docs.yml` (publish the docs
site). Don't tag from a feature branch, don't force-push tags, don't
build or publish release artifacts by hand.

## R9. `/release`, `/loop`, `/schedule` are user-triggered

The user runs these; they have side effects and billing implications.
Claude does not initiate them. If you finish work that would benefit,
offer in a single trailing line.
