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
editor = ""           # command for `kura edit`; falls back to $EDITOR, then vi
stale_days = 180

[llm]
provider = "auto"     # auto | ollama | lmstudio | none
ollama_url = "http://localhost:11434"
lmstudio_url = "http://localhost:1234"

[llm.models]
embedding = "qwen3-embedding:0.6b"
embedding_dimensions = 1024
reranker = "dengcao/Qwen3-Reranker-0.6B"
generation = "qwen3:4b"

[search]
rrf_k = 60
keyword_weight = 1.0
vector_weight = 1.0
rerank_top_k = 20
default_limit = 10

[clip]
path = "clips"

[browser]
port = 7578
```

### `[general]`

| Key | Meaning |
|---|---|
| `default_bucket` | Bucket new documents land in when none is given |
| `editor` | Command `kura edit` opens; empty falls back to `$EDITOR`, then `vi` |
| `stale_days` | A document untouched this long is a staleness candidate (`kura ls --stale`) |

### `[llm]`

`provider` selects the local LLM backend:

- `auto` — try Ollama first, then LM Studio (the default).
- `ollama` / `lmstudio` — force one backend.
- `none` — disable LLM features entirely; kura runs keyword-only.

`ollama_url` (default `http://localhost:11434`) and `lmstudio_url`
(default `http://localhost:1234`) point kura at each backend — change
them for a non-default host or port.

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

### `[search]`

Hybrid-search tuning; the defaults suit most stores.

| Key | Meaning |
|---|---|
| `rrf_k` | Reciprocal-rank-fusion constant when merging keyword and vector hits |
| `keyword_weight` / `vector_weight` | Relative weight of each list in the fusion |
| `rerank_top_k` | How many fused candidates the local LLM reranks |
| `default_limit` | Result count when `--limit` is omitted |

### `[clip]`

| Key | Meaning |
|---|---|
| `path` | Document path new clips are filed under (default `clips`); set `""` to clip into the bucket root |

### `[browser]`

| Key | Meaning |
|---|---|
| `port` | Port `kura browser` listens on (default `7578`); `--port` overrides it |

## Environment variables

| Variable | Effect |
|---|---|
| `KURA_HOME` | Data directory (default `~/.kura`) |
| `KURA_DB` | Path to the database file, overriding `KURA_HOME/kura.db` |
| `NO_COLOR` | Disable colored CLI output |

`KURA_HOME` is the clean way to keep separate knowledge bases — point
it at a different directory per project or context, and each gets its
own SQLite store and config.
