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
  key, a `#key`, a full path (`db/sqlite/Notes`), a unique title, or a
  unique alias (e.g. `kura get "Today's note"` or `kura get #a1b2c3`).
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
| `kura add <file>` | Add a document; `-` reads stdin; `--path`, `--tags`, `--title`, `--bucket` |
| `kura get <ref>` | Print a document (Markdown or `--json`); `--as-of 2026-03-01` shows it as it was then |
| `kura edit <ref>` | Open in your editor (`general.editor` → `$EDITOR` → `vi`); frontmatter edits title, path, and tags too |
| `kura rm <ref>` | Delete a document |
| `kura mv <ref> [<title>]` | Rename and/or move (`--path`); rewrites wiki links. `--prefix <old> <new>` moves a whole subtree |
| `kura mv suggest` | Propose paths for unfiled documents from links/tags/search signals (plus the LLM when available); `--apply`, `--json`, `--limit` |
| `kura ls` | List documents; `--tag`, `--bucket`, `--prefix`, `--sort`, `--stale` |
| `kura history <ref>` | List a document's revisions — every edit keeps the replaced version. `show <ref> <rN>` prints one; `restore <ref> <rN>` brings its content back (and is itself undoable) |
| `kura clip <url>` | Capture a web page, cleaned up by the LLM; filed under `clip.path` (default `clips`) |
| `kura export --dir <d>` | Write documents as Markdown with frontmatter; paths become subdirectories |
| `kura import <dir>` | Round-trip via `kura_key` (update or create); subdirectories become document paths |

## Search

| Command | Mode | Notes |
|---|---|---|
| `kura search <q>` | Keyword | FTS5 BM25; always available; < 100 ms |
| `kura vsearch <q>` | Semantic | Vector KNN over local embeddings |
| `kura query <q>` | Hybrid | Fuse keyword + vector, then local-LLM rerank |
| `kura ask <question>` | Answer | Answer the question from the top hits, citing sources as `[1]`, `[2]`, … |
| `kura embed` | — | (Re)generate embeddings for documents missing them |

See [Search](/kura/search/) for how the modes differ and their
degraded behavior without an LLM provider.

## Organization

| Command | What it does |
|---|---|
| `kura bucket ls\|add\|rm\|mv` | Manage buckets (`mv` renames) |
| `kura tag ls` | List tags; `--tree` for the hierarchy |
| `kura tag add\|rm <doc> <tag>…` | Add or remove tags on a document |
| `kura tag mv <old> <new>` | Rename or merge a tag subtree |
| `kura tag gc` | Remove tags no document uses |
| `kura tag suggest` | LLM tag suggestions; `--untagged`, `--apply` (reuses your taxonomy) |
| `kura tag audit` | Merge candidates for similar tags; oversized-tag warnings |
| `kura link ls <ref>` | Outlinks, backlinks, and 2-hop links for a document |
| `kura link broken` | List unresolved wiki links |
| `kura alias ls\|add\|rm <doc> <alias>…` | Manage aliases (alternate titles): `[[alias]]` links resolve to the document and search matches it |

## Servers & agent integration

| Command | What it does |
|---|---|
| `kura browser` | Serve the browser UI at `http://127.0.0.1:7578` |
| `kura mcp` | Run the MCP server on stdio for AI agents |
| `kura mcp --print-config` | Print an `.mcp.json` snippet |
| `kura skills install` | Install the `kura-cli` agent skill (a CLI guide for AI agents) into `~/.agents/skills` (`--dir` overrides) |
| `kura skills show` | Print the skill to stdout; `kura skills uninstall` removes it |

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
