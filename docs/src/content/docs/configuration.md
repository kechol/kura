---
title: Configuration
description: The config.toml file, LLM model settings, and environment variables that control where kura stores data and which provider it uses.
---

kura reads `~/.kura/config.toml`. Edit it directly, or use
`kura config`:

```sh
kura config list
kura config get llm.provider
kura config set general.stale_days 90
```

## `config.toml`

```toml
[general]
default_bucket = "main"
stale_days = 180

[llm]
provider = "auto"     # auto | ollama | lmstudio | none

[llm.models]
embedding = "qwen3-embedding:0.6b"
embedding_dimensions = 1024
reranker = "dengcao/Qwen3-Reranker-0.6B"
generation = "qwen3:4b"

[clip]
path = "clips"
```

### `[general]`

| Key | Meaning |
|---|---|
| `default_bucket` | Bucket new documents land in when none is given |
| `stale_days` | A document untouched this long is a staleness candidate (`kura ls --stale`) |

### `[llm]`

`provider` selects the local LLM backend:

- `auto` — try Ollama first, then LM Studio (the default).
- `ollama` / `lmstudio` — force one backend.
- `none` — disable LLM features entirely; kura runs keyword-only.

### `[llm.models]`

The models kura asks the provider for. Defaults are small enough to run
together on a 32 GB Mac:

| Key | Used for |
|---|---|
| `embedding` | Vectors for semantic and hybrid search |
| `embedding_dimensions` | Vector width; must match the embedding model |
| `reranker` | Reranking in `kura query` |
| `generation` | `kura clip` cleanup, tag suggestion, query expansion |

:::caution
After changing the embedding model or its dimensions, run
`kura doctor --fix` (to detect the change) and then `kura embed` to
regenerate every vector at the new dimensions. Old vectors are not
compatible across models.
:::

### `[clip]`

| Key | Meaning |
|---|---|
| `path` | Document path new clips are filed under (default `clips`); set `""` to clip into the bucket root |

## Environment variables

| Variable | Effect |
|---|---|
| `KURA_HOME` | Data directory (default `~/.kura`) |
| `KURA_DB` | Path to the database file, overriding `KURA_HOME/kura.db` |
| `NO_COLOR` | Disable colored CLI output |

`KURA_HOME` is the clean way to keep separate knowledge bases — point
it at a different directory per project or context, and each gets its
own SQLite store and config.
