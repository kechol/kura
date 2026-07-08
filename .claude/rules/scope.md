---
description: Product-scope guardrails for kura — local-only, no telemetry, the closed list of sanctioned network calls, degraded operation, and what is out of scope for v1.
---

# Scope rules

## R1. kura is local-only; the network allowlist is closed

kura is a local tool. Do not add HTTP clients, version-check pings, or
analytics. The **only** sanctioned network access is:

1. The SHA256-pinned sqlite-vaporetto download from GitHub Releases
   during `kura init` / `kura doctor --fix`.
2. Build-time prebuilt fetches from the npm registry
   (`scripts/fetch-vendor.ts`).
3. localhost LLM providers (Ollama / LM Studio).
4. The user-initiated `kura clip <url>` fetch.
5. The browser UI's lazy mermaid load from `cdn.jsdelivr.net`
   (browser-side, only when a document contains a mermaid block; fails
   soft offline).

Anything new on this list is a design discussion, not a chore commit.
See `CLAUDE.md` for the canonical wording.

## R2. No telemetry, no phoning home

No usage counters, no crash reporting, no "check for updates". A user
who runs kura on an airplane loses only the four network features in R1,
and each of those degrades or is explicitly user-initiated.

## R3. Degraded operation is a product guarantee, not an implementation detail

Keyword search, document CRUD, links, and tags work with **no LLM
provider and no vaporetto extension**. This is a promise kura makes to
users, so it is also a scope rule: a feature proposal that only works
"when Ollama is running" is out of scope unless it also ships a
keyword-only / no-provider path. (The code-level obligation is
`invariants.md` R4.)

## R4. Data lives in one SQLite file; no hidden state

The store is a single SQLite database at `~/.kura/kura.db` (override with
`KURA_DB`), plus the config at `~/.kura/config.toml` and downloaded
extensions under `~/.kura/`. No sidecar index files, no per-run caches
that outlive the process, no lockfiles left behind. `kura export` /
`kura import` round-trip the whole store as Markdown with frontmatter —
that is the backup and portability story.

## R5. No document folder hierarchy

Organization is buckets + hierarchical tags (`tech/db/sqlite`) + wiki
links (`[[Title]]`) — the Cosense model. Don't propose a directory tree,
notebooks, or nested collections; those recreate the filing problem kura
exists to avoid.

## R6. Distribution is a single self-contained binary

kura ships as one `bun build --compile` binary per platform with the SPA
assets and the sqlite-vec extension embedded. There is no plugin system,
no separate asset download beyond the runtime vaporetto model, and no
package-manager-specific build. Homebrew and the release ZIPs both wrap
the same binary.

## R7. Internal docs target contributors; user docs target newcomers

`docs/` (Astro Starlight, en + ja) and `README.md` / `README.ja.md`
target someone who just installed kura. No internal jargon
(`documents_fts`, `chunks_vec`, "repository layer", `meta.fts_tokenizer`).

`.claude/docs/` and `.claude/rules/` target a contributor or an AI agent
changing this codebase; internal jargon is expected there. If you are
tempted to put schema or pipeline detail into user docs, redirect to
`.claude/docs/` and link from a one-sentence user summary.
