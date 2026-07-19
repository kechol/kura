---
title: Search
description: The three search modes — keyword, semantic, and hybrid — how they differ, and how each degrades without an LLM provider.
---

kura offers three search commands that trade speed for quality. All
three run entirely on your machine.

## The three modes

### `kura search` — keyword

FTS5 full-text search with BM25 ranking. On a fresh install this uses
the [sqlite-vaporetto](https://github.com/hotchpotch/sqlite-vaporetto)
morphological tokenizer, so a Japanese query splits into real words
rather than character n-grams. It is fast (typically under 100 ms) and
needs **no LLM provider** — this is the mode that always works.

```sh
kura search "WAL checkpoint"
```

Reach for it when you know roughly which words appear in the document.

### `kura vsearch` — semantic

Vector K-nearest-neighbor search over embeddings, using
[sqlite-vec](https://github.com/asg017/sqlite-vec). Documents are
chunked and embedded by a local model, so a query matches on **meaning**
rather than exact words — "how writes stay readable" can surface a note
titled "WAL checkpointing" even with no shared terms.

```sh
kura vsearch "how writes stay readable"
```

`vsearch` needs embeddings, which need a provider. See
[degradation](#degradation-without-a-provider) below.

### `kura query` — hybrid (best quality)

The full pipeline: run keyword and semantic search, fuse the two
ranked lists, then rerank the top candidates with a local LLM. This is
the highest-quality mode and the one to use when you're not sure of the
exact wording.

```sh
kura query "SQLite concurrency"
```

## Which mode to use

| You know… | Use |
|---|---|
| the words that appear | `kura search` |
| only the idea, not the words | `kura vsearch` |
| you want the best answer, wording aside | `kura query` |

## Embeddings

Semantic and hybrid search read from a vector index that has to be
populated. `kura add` embeds new documents when a provider is
available; `kura embed` (re)generates any that are missing. `kura status`
reports embedding coverage so you can tell when a backfill is due.

If you change the embedding model, run `kura doctor --fix` (to detect
the change) and then `kura embed` to regenerate vectors at the new
model's dimensions.

## Degradation without a provider

Keyword and hybrid search work offline; only pure semantic search needs
a model:

- **`kura search`** works with or without a provider — always.
- **`kura query`** falls back toward keyword results when semantic
  search or reranking is unavailable, so you still get an answer — just
  without the model-driven quality boost.
- **`kura vsearch`** is the exception: it requires an embedding provider
  and does not fall back. With none reachable it exits with code `4`
  (LLM provider unavailable). Use `kura query` when you want a result
  that degrades to keyword search instead.

This is a core guarantee: the knowledge base stays searchable offline.
See [Configuration](/kura/configuration/) to choose or disable the
provider.
