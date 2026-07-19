---
title: AI Agents (MCP)
description: Expose kura to Claude Code and other AI agents through its MCP server, and use --json output from any read command.
---

kura is designed to be an AI agent's long-term memory. It speaks the
[Model Context Protocol](https://modelcontextprotocol.io/) over stdio,
so an agent can search your knowledge base and add to it as part of its
normal tool use.

## Connect it to Claude Code

```sh
claude mcp add kura -- kura mcp
```

For any other MCP client, print a ready-made config snippet:

```sh
kura mcp --print-config     # prints an .mcp.json entry
```

Then run `kura mcp` — it serves on stdio and stays local; no network,
no account.

## Exposed tools

| Tool | Purpose |
|---|---|
| `kura_query` | Hybrid search (keyword + semantic + rerank) — the default retrieval tool |
| `kura_ask` | Ask a question, answered from your notes with cited sources |
| `kura_search` | Keyword search (FTS5 BM25) |
| `kura_get` | Fetch a document by key, full path (`clips/Title`), or title |
| `kura_add` | Create a document; an optional `path` files it under a folder-like document path |
| `kura_update` | Update an existing document; changing `title` or `path` rewrites `[[links]]` in referring documents |
| `kura_list_tags` | List the tag hierarchy |
| `kura_related` | Documents related to a given one (outlinks, backlinks, 2-hop links) |
| `kura_changes` | What changed since a point in time (`7d`, a date) — renames and moves included |
| `kura_status` | Store statistics |

An agent typically starts a session with `kura_changes` to catch up on
what changed, reaches for `kura_query` to recall context (or `kura_ask`
for an answer with citations), `kura_related` to explore around a hit,
and `kura_add` / `kura_update` to write findings back — turning kura
into durable memory across sessions.

## Degraded operation

The MCP tools follow the same rule as the CLI: `kura_search` and
`kura_changes` work with no LLM provider, `kura_query` falls back
toward keyword results when semantic search or reranking is
unavailable, and `kura_ask` returns search results instead of an answer
(see [Search](/kura/search/)). An agent never gets a hard failure just
because no model is running.

## `--json` everywhere

If you'd rather script kura than speak MCP, every read command supports
`--json`:

```sh
kura query "SQLite concurrency" --json
kura get "Today's note" --json
kura status --json
```

The JSON shapes are stable contracts — the same payloads back the MCP
tools — so you can build on them safely.
