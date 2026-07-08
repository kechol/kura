---
title: Concept
description: Why kura drops the folder hierarchy and how buckets, hierarchical tags, and wiki links organize documents instead.
---

kura is built on a single bet: **the folder is the wrong primitive for
notes.** Every hierarchy forces one filing decision per document, and
that decision is wrong the moment a note belongs in two places. kura
removes the hierarchy and lets structure emerge from the content
instead.

## Three ways things connect

### Buckets

A **bucket** is a flat, top-level grouping — think "work", "personal",
"reading". Every document lives in exactly one bucket (default:
`main`). Buckets are for coarse separation, not filing; you rarely
need more than a handful.

### Hierarchical tags

Tags carry the structure a folder tree usually would, but without
forcing a single home. A document tagged `#tech/db/sqlite` shows up
under `tech`, `tech/db`, and `tech/db/sqlite` at once. Tags are
written inline in the body (`#tech/db/sqlite`) and extracted on save,
or set explicitly with `--tags`.

Because tags are cheap and multi-valued, a note about running SQLite
in production can be `#tech/db/sqlite` **and** `#ops/reliability`
without you choosing which drawer it goes in.

### Wiki links

`[[Title]]` links one document to another by title. The twist that
makes it work for note-taking: **write the link before the target
exists.** kura records it as an unresolved link, and the moment a
document with that title is created, the link connects automatically —
the [Cosense](https://scrapbox.io/) model. Backlinks and two-hop links
(documents that share a neighbor) fall out of the same graph for free.

## Hybrid search, tuned for Japanese

Self-organization only pays off if retrieval is good. kura's search is
a hybrid pipeline designed for Japanese text from the start:

- **Keyword search** uses SQLite FTS5 with the
  [sqlite-vaporetto](https://github.com/hotchpotch/sqlite-vaporetto)
  morphological tokenizer, so Japanese queries split on real word
  boundaries instead of character n-grams.
- **Semantic search** uses [sqlite-vec](https://github.com/asg017/sqlite-vec)
  KNN over embeddings produced by a local model.
- **Hybrid search** fuses both result sets and reranks them with a
  local LLM for the best quality.

See [Search](/kura/search/) for how the three modes differ and when to
reach for each.

## Local, single-file, degradable

kura's whole store is one SQLite file at `~/.kura/kura.db`. There is no
server to run, no account, and no telemetry. LLM features use a local
provider (Ollama or LM Studio) that kura auto-detects — and when none
is reachable, every model-dependent feature degrades with a warning
rather than failing. Keyword search, CRUD, links, and tags never need
a model at all.

`kura export` and `kura import` round-trip the entire store as Markdown
with frontmatter, so your data is portable and diff-friendly, not
locked inside the database.

## For humans and agents alike

The same core powers three front ends: the CLI, a local
[browser UI](/kura/installation/) (viewer, editor, and a knowledge
graph), and an [MCP server](/kura/mcp/) that exposes search and CRUD as
tools for AI agents. Every read command also supports `--json`, so kura
fits into scripts and agents as naturally as it fits your terminal.
