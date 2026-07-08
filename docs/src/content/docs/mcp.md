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
| `kura_search` | Keyword search (FTS5 BM25) |
| `kura_get` | Fetch a document by key or title |
| `kura_add` | Create a document |
| `kura_update` | Update an existing document |
| `kura_list_tags` | List the tag hierarchy |
| `kura_related` | Documents related to a given one (links + similarity) |
| `kura_status` | Store statistics |

An agent typically reaches for `kura_query` to recall context,
`kura_related` to explore around a hit, and `kura_add` / `kura_update`
to write findings back — turning kura into durable memory across
sessions.

## Degraded operation

The MCP tools follow the same rule as the CLI: `kura_search` works with
no LLM provider, and `kura_query` falls back toward keyword results
when semantic search or reranking is unavailable (see
[Search](/kura/search/)). An agent never gets a hard failure just
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
