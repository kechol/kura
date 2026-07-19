---
description: Canonical-name and language-data enforcement for kura — use the product's own terms verbatim, keep CJK test data Japanese, and preserve the two intentionally-Japanese product surfaces.
---

# Terminology rules

kura has no separate glossary file; the canonical names are the ones the
code and `.claude/docs/` already use. These rules keep them consistent.

## R1. Use kura's terms verbatim

- The product is **kura** (lowercase, in prose, commands, and source).
  Not "Kura", not "kura-cli". The Homebrew formula is `kura`
  (`brew install kechol/tap/kura`).
- Commands are spelled as registered in `src/cli/index.ts`
  (`kura search`, `kura vsearch`, `kura query` are three distinct
  commands — keyword, semantic, hybrid+rerank — never blur them).
- Domain terms carry their kura meaning: **bucket** (top-level grouping,
  not "folder" / "notebook"), **document path** (`documents.path`, an
  optional slash-separated namespace like `clips/技術`; `''` = bucket
  root — a naming/browsing aid, never a forced filing location, and
  case-preserving unlike tags), **hierarchical tag** (`tech/db/sqlite`),
  **wiki link** (`[[Title]]`, or `[[full/path/Title]]` to pin one
  document), **doc key** / `kura_key` (stable identity used by
  `get` / `export` / `import`), **hybrid search** (RRF fusion of
  FTS + vector, then rerank).
- The three search modes map to fixed pipeline stages
  (docs: search-pipeline.md). Don't relabel `query` as "search" in
  user-facing text.

## R2. Renames sweep in the same PR

See `workflow.md` R2 for the sweep target list. A renamed `--json` key or
MCP tool name is a breaking change (`invariants.md` R7): the MCP schema,
consuming skill text, docs, and CHANGELOG move together.

## R3. CJK test data must stay Japanese

Fixture documents (`tests/fixtures/docs/`), search queries, titles, tags,
and content assertions exist to prevent regressions in Japanese
tokenization, BM25 ranking, snippet generation, and chunking. They are
**test-critical data, not incidental strings** — translating them to
English silently guts the tests (a trigram/ASCII query cannot exercise
the vaporetto morphological path). English-only search tests are not
acceptable. See `CLAUDE.md` and `.claude/docs/testing.md`.

## R4. The two intentionally-Japanese product surfaces

kura is a Japanese-first knowledge tool, so two product surfaces are
Japanese by design:

- Browser UI strings under `src/client/`.
- LLM prompt templates (clip formatting, tag suggestion, query
  expansion, answer generation, contradiction audit) — tuned for
  Japanese content.

Everything else user-facing (CLI output, MCP descriptions, errors) is
English (`workflow.md` R7). Keep the comments around the Japanese
surfaces in English.

For the Japanese doc mirror (`README.ja.md`,
`docs/src/content/docs/ja/*`): translate **meaning**, not English
sentence structure. Prefer 「〜できます」 over
「〜することができます」; drop pronouns; neutral 丁寧語 only. Keep
command names (`kura query`), config keys (`default_bucket`), and code
identifiers verbatim in `code`.

On spacing, follow the existing `README.ja.md` convention: a single
half-width space **between a Latin/number/code token and adjacent
Japanese** is intentional and idiomatic (`SQLite に格納`, `Ollama や
LM Studio`, `FTS5 全文検索`) — keep it. What is an artifact, and must be
swept, is a stray space **between two Japanese tokens**
(`コードベース を 観測` is wrong) — a common mechanical-translation
byproduct. Fix those on every PR.
