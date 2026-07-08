---
title: CLI
description: Every kura command grouped by task, with global conventions, --json output, and exit codes.
---

`kura <command> [options]`. Run `kura --help` for the command list and
`kura <command> --help` for a command's flags.

## Global conventions

- **`--json`** — every read command can emit machine-readable JSON
  instead of formatted text. Handy for scripts and consumed by the
  [MCP server](/kura/mcp/).
- **Document references** — commands that take a document accept a doc
  key, a `#key`, or a title (e.g. `kura get "Today's note"` or
  `kura get #a1b2c3`).
- **`NO_COLOR`** — set it to disable colored output.
- **Data location** — `KURA_HOME` overrides the data directory
  (default `~/.kura`); `KURA_DB` overrides the database file.

## Setup & health

| Command | What it does |
|---|---|
| `kura init` | Create `~/.kura`, download the tokenizer, create the DB |
| `kura doctor` | Diagnose SQLite, extensions, LLM providers, DB integrity |
| `kura doctor --fix` | Repair the index, GC orphans, re-resolve links, detect embedding-model changes |
| `kura status` | Store statistics: counts, embedding coverage, stale candidates |
| `kura config list\|get\|set` | Read and write `~/.kura/config.toml` |

## Documents

| Command | What it does |
|---|---|
| `kura add <file>` | Add a document; `-` reads stdin; `--tags`, `--title`, `--bucket` |
| `kura get <ref>` | Print a document (Markdown or `--json`) |
| `kura edit <ref>` | Open in `$EDITOR`; frontmatter edits title and tags too |
| `kura rm <ref>` | Delete a document |
| `kura mv <ref> <title>` | Rename a document (updates wiki links) |
| `kura ls` | List documents; `--tag`, `--bucket`, `--sort`, `--stale` |
| `kura clip <url>` | Capture a web page, cleaned up by the LLM |
| `kura export --dir <d>` | Write documents as Markdown with frontmatter |
| `kura import <dir>` | Round-trip via `kura_key` (update or create) |

## Search

| Command | Mode | Notes |
|---|---|---|
| `kura search <q>` | Keyword | FTS5 BM25; always available; < 100 ms |
| `kura vsearch <q>` | Semantic | Vector KNN over local embeddings |
| `kura query <q>` | Hybrid | Fuse keyword + vector, then local-LLM rerank |
| `kura embed` | — | (Re)generate embeddings for documents missing them |

See [Search](/kura/search/) for how the modes differ and their
degraded behavior without an LLM provider.

## Organization

| Command | What it does |
|---|---|
| `kura bucket ls\|add\|rm` | Manage buckets |
| `kura tag ls` | List tags; `--tree` for the hierarchy |
| `kura tag suggest` | LLM tag suggestions; `--untagged`, `--apply` (reuses your taxonomy) |
| `kura tag audit` | Merge candidates for similar tags; oversized-tag warnings |
| `kura link ls <ref>` | Outlinks, backlinks, and 2-hop links for a document |
| `kura link broken` | List unresolved wiki links |

## Servers

| Command | What it does |
|---|---|
| `kura browser` | Serve the browser UI at `http://127.0.0.1:7578` |
| `kura mcp` | Run the MCP server on stdio for AI agents |
| `kura mcp --print-config` | Print an `.mcp.json` snippet |

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error (including conflicts, e.g. a unique-constraint violation) |
| `2` | Usage error (bad arguments) |
| `3` | Not found (no such document) |
| `4` | LLM provider unavailable |

Scripts can rely on these: exit `4` specifically means "the feature
needs a model and none was reachable", distinct from a genuine error.
