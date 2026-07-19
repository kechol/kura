# LLM Providers

> Covers SPEC §6. Key sources: `src/core/llm/provider.ts`,
> `src/core/llm/ollama.ts`, `src/core/llm/lmstudio.ts`,
> `src/core/llm/cache.ts`. Tests: `tests/search.test.ts` (mock provider),
> `tests/m6.test.ts`.

## Provider interface

`LLMProvider` (`src/core/llm/provider.ts`) is the only surface the rest of
the codebase talks to:

```typescript
interface LLMProvider {
  name: "ollama" | "lmstudio";
  isAvailable(): Promise<boolean>;
  hasModel(model: string): Promise<boolean>;
  embed(texts: string[], model: string, dimensions?: number): Promise<Float32Array[]>;
  chat(messages: Message[], model: string, opts?: ChatOptions): Promise<string>;
}
```

Both implementations extend the shared `OpenAICompatProvider` base class,
which implements `embed` / `chat` against the OpenAI-compatible endpoints
both servers expose; only *detection* differs per provider:

| Provider | Base URL (config) | `isAvailable` / `hasModel` endpoint | Model matching |
| --- | --- | --- | --- |
| Ollama | `llm.ollama_url` (default `http://localhost:11434`) | `GET /api/tags` | case-insensitive, `:latest` suffix normalized away |
| LM Studio | `llm.lmstudio_url` (default `http://localhost:1234`) | `GET /v1/models` | case-insensitive id comparison |

### Shared OpenAI-compatible transport

- `POST /v1/embeddings` — batched input; the optional `dimensions` body
  field is sent only when configured; responses are re-sorted by `index`
  and validated to match the input count. Results come back as
  `Float32Array[]`.
- `POST /v1/chat/completions` — `temperature` defaults to 0,
  `stream: false`; the reply is `choices[0].message.content` (an error if
  absent). Logprobs are never requested (see Deviations).
- **Timeouts**: detection calls (`isAvailable` / `hasModel`) abort after
  **2 s**; `embed` / `chat` requests after **120 s** (local models can be
  slow to first token). Non-2xx responses raise with the status and the
  first 200 chars of the body.

## Provider resolution

`resolveProvider(config)` implements SPEC §6's resolution order:

- `llm.provider = "auto"` (default): **Ollama → LM Studio → none**. The
  first provider whose `isAvailable()` succeeds wins.
- `"ollama"` / `"lmstudio"`: only that provider is probed — **no fallback
  to the other** when it is down (returns `null`).
- `"none"`: always `null`; LLM features run in their degraded mode.

The detection result (including `null`) is cached **in-process for 60
seconds** (`DETECTION_TTL_MS`), so a burst of commands in one process pays
detection once. There is no cross-process cache; every CLI invocation
re-detects at most once.

- **Test injection**: `setProviderForTests(provider)` pins the resolution
  result and clears the detection cache. Passing `null` means "no provider"
  (degraded-mode tests); passing `undefined` clears the override. Tests must
  never talk to a live server (see [testing.md](testing.md)).
- **Hard requirement**: `requireProvider(config)` throws
  `LLMUnavailableError` when resolution yields `null`; the CLI entry point
  (`src/cli/index.ts`) maps that to **exit code 4**. Features that can
  degrade use `resolveProvider` and handle `null` themselves.

## Default models

Configured under `[llm.models]` (`src/core/config.ts`); chosen so that all
three fit simultaneously on a 32 GB Mac (< 4 GB total, SPEC §6):

| Role | Default model | Why |
| --- | --- | --- |
| embedding | `qwen3-embedding:0.6b` | 1024 dimensions (matches `embedding_dimensions` and the `chunks_vec` schema), multilingual with good Japanese recall, small footprint. SPEC names `kun432/cl-nagoya-ruri-large` as a Japanese-accuracy alternative — change dimensions in config alongside it. |
| reranker | `dengcao/Qwen3-Reranker-0.6B` | Purpose-built yes/no relevance judge; the prompt in `src/core/search/rerank.ts` follows the Qwen3-Reranker instruct format. |
| generation | `qwen3:4b` | Clip formatting, tag suggestion, query expansion, and answer generation (`kura ask`) need a general instruct model; 4B runs comfortably alongside the other two. |

**Changing models**: edit config (`kura config set llm.models.…`), then run
`kura embed --all` for embedding changes. `kura doctor` detects a
`meta` ↔ config mismatch and recreates `chunks_vec` at the new dimension
(`recreateVecIfModelChanged()` in `src/core/doctor.ts`); `kura embed`
records the model back into `meta` when it finishes. `doctor` also warns
about required models missing from Ollama with ready-to-run
`ollama pull` commands. See [configuration.md](configuration.md) and
[self-healing.md](self-healing.md).

## llm_cache

`src/core/llm/cache.ts` provides a **read-through** cache over the
`llm_cache` table (see [data-model.md](data-model.md)):
`cached(db, purpose, model, input, fn)` returns a hit, otherwise runs `fn`
and upserts the JSON-serialized result. The cache key is
`sha256(purpose \x00 model \x00 input)`, so switching models naturally
invalidates old entries. There is no TTL or eviction; rows persist until
deleted manually. A row whose JSON fails to parse is treated as a miss.

Purpose ledger — every purpose, its key composition, and its single writer:

| Purpose | Model key | Input key composition | Written by | Cached value |
| --- | --- | --- | --- | --- |
| `expand` | `llm.models.generation` | raw query string | `expandQuery()` — `src/core/search/expand.ts` | up to 2 query variants (`string[]`) |
| `rerank` | `llm.models.reranker` | `query \x00 candidateText` (text pre-truncated to 2,000 chars) | `rerankCandidates()` — `src/core/search/rerank.ts` | relevance score (`1 \| 0 \| 0.5`) |
| `tag` | `llm.models.generation` | `sha256(first 4,000 chars) \x00 existing-tag list (≤ 200 tags)` | `suggestTagsForText()` — `src/core/clip/format.ts` | up to 5 tag paths (`string[]`) |
| `clip` | `llm.models.generation` | `page URL \x00 sha256(turndown markdown)` | `formatClip()` — `src/core/clip/format.ts` | `{ title, markdown }` |
| `ask` | `llm.models.generation` | `question \x00 key1:contentHash1,key2:contentHash2,…` (the cited sources) | `askQuestion()` — `src/core/search/ask.ts` | answer text (`string`, `<think>` blocks stripped) |
| `audit` | `llm.models.generation` | sorted pair of excerpt SHA256 hashes, `:`-joined (1,200 chars per side) | `findContradictions()` — `src/core/audit.ts` | contradiction verdict (`1 \| 0 \| 0.5` via `parseYesNo`) |

Note the `tag` key includes the existing-tag list: growing the taxonomy
intentionally invalidates old suggestions so the "reuse existing tags"
instruction sees fresh context. Likewise the `ask` key includes each cited
source's `content_hash`, so editing a source document invalidates the
cached answer, and the `audit` key hashes both excerpts — a verdict stays
cached until either side's text changes (the sort makes it
order-independent).

## Degradation matrix

Degraded operation is a hard requirement (`CLAUDE.md`): a feature either
works without a provider (with a warning) or fails fast with exit 4 —
never silently misbehaves.

| Feature | Provider handling | Behavior when no provider is reachable |
| --- | --- | --- |
| `kura search` | none needed | Unaffected — pure FTS. |
| `kura vsearch` | `requireProvider` | `LLMUnavailableError`, **exit 4**. |
| `kura query` | `resolveProvider` | Keyword-only results + warning pointing at `kura doctor`; exit 0. |
| `kura query --expand` | via `hybridQuery` | Expansion skipped with a warning; original query only. |
| `kura ask` | `resolveProvider` | Answer generation skipped with a warning; the plain hybrid hit list is shown instead (`answer: null`); exit 0. A generation failure degrades the same way. |
| rerank stage (inside `query`) | via `hybridQuery` | RRF order returned as-is (`usedRerank: false`); also the fallback when the rerank call throws. |
| `kura clip` | `resolveProvider` | Warning, then mechanical turndown conversion (`llmFormatted: false`) and **no tag suggestions**. `--no-llm` forces the same path. A formatting failure or an LLM answer that dropped the body (< 40 chars) also falls back to turndown. |
| `kura tag suggest` | `requireProvider` | `LLMUnavailableError`, **exit 4** — suggestions are the whole feature. |
| `kura tag audit` | `resolveProvider` | Warning "auditing with edit distance only"; embedding-similarity merge candidates are skipped (`usedEmbeddings: false`), edit-distance and singular/plural detection still run (`src/core/gardening.ts`). |
| `kura audit` | `requireProvider` | `LLMUnavailableError`, **exit 4** — both the candidate embeddings and the judge need a provider. |

`kura embed` also uses `requireProvider` (exit 4), but only after checking
that pending chunks exist — with nothing to do it exits 0 without touching
the network.

## Intentionally-Japanese prompts

kura is a Japanese-first knowledge tool; exactly **five prompt templates
are deliberately written in Japanese** and tuned for Japanese content
(policy in `CLAUDE.md`). Each is marked with an
`// Intentionally Japanese` comment; the surrounding code comments stay
English:

1. Query expansion — `PROMPT` in `src/core/search/expand.ts`
2. Clip formatting — `FORMAT_PROMPT` in `src/core/clip/format.ts`
3. Tag suggestion — `TAG_PROMPT` in `src/core/clip/format.ts`
4. Answer generation — `PROMPT` in `src/core/search/ask.ts`
5. Contradiction audit — `PROMPT` in `src/core/audit.ts`

Do not translate these to English "for consistency" — that would degrade
output quality on Japanese content. The **rerank prompt is intentionally
English** because it follows the Qwen3-Reranker instruct format the model
was trained on, not because of the language policy.

## Deviations from SPEC

1. **No logprobs-based rerank confidence** — the SPEC §2 stack table says
   yes/no judgment with "logprobs used for confidence when available".
   `chat()` never requests logprobs; rerank scores are strictly
   1 / 0 / 0.5 parsed from the answer text
   (see [search-pipeline.md](search-pipeline.md)).
2. **`requireProvider`'s error message does not point at `kura doctor`** —
   SPEC §6 says provider-less errors should direct users to `doctor`. The
   hard-failure message suggests checking that a provider is running or
   reviewing config; only `kura query`'s degraded-mode warning mentions
   `doctor`.

## Related docs

- [search-pipeline.md](search-pipeline.md) — how expand / rerank / vector
  search consume providers
- [configuration.md](configuration.md) — `[llm]` config keys and precedence
- [self-healing.md](self-healing.md) — doctor's provider and model checks
- [testing.md](testing.md) — the mock-provider policy for LLM tests
