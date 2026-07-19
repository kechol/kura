# Search Pipeline

> Covers SPEC §5. Key sources: `src/core/search/keyword.ts`,
> `src/core/search/vector.ts`, `src/core/search/hybrid.ts`,
> `src/core/search/rerank.ts`, `src/core/search/expand.ts`,
> `src/core/search/ask.ts`, `src/core/chunker.ts`. Tests:
> `tests/search.test.ts`, `tests/regression-search.test.ts`,
> `tests/chunker.test.ts`, `tests/ask.test.ts`.

## Search modes (SPEC §5.1)

| Command | Method | Latency target | LLM requirement | Degraded behavior |
| --- | --- | --- | --- | --- |
| `kura search` | FTS5 BM25 only | < 100 ms | none | Always works. Trigram DBs get a LIKE fallback for sub-3-char terms (see below). A vaporetto DB whose extension fails to load errors with a `kura doctor` hint. |
| `kura vsearch` | Vector KNN only | < 500 ms (incl. query embedding) | embedding | No degraded mode by design: `requireProvider` throws `LLMUnavailableError` (exit 4). Degradation is `kura query`'s job. |
| `kura query` | Hybrid + rerank | < 5 s | embedding + reranker (both optional) | Never fails hard. Missing provider → keyword-only + warning; vector or rerank failure → warning and continue. |
| `kura ask` | Hybrid + answer generation | LLM-bound | generation (optional) | Never fails hard. Missing provider or generation failure → `answer: null` + warning; callers show the plain hybrid hits instead (see below). |

The same three search modes back the REST endpoint (`/api/search?mode=`) and
the MCP tools (`kura_search`, `kura_query`) — see [http-api.md](http-api.md)
and [mcp-server.md](mcp-server.md). Answer generation is exposed as the
`kura_ask` MCP tool but has **no REST endpoint** (the browser UI does not
surface it). All handlers reuse the `src/core/search/` functions; nothing is
reimplemented server-side.

## Hybrid pipeline (`kura query`)

Implemented in `hybridQuery()` (`src/core/search/hybrid.ts`):

```
query
  │
  ├─ (--expand) LLM query expansion ············ llm_cache('expand')
  │     original query (weight 2) + up to 2 variants (weight 1)
  │
  ├─ per variant: FTS5 BM25 ──── top 50 docs ──┐
  │                                            ├─ RRF fusion (rrf_k = 60)
  ├─ per variant: vector KNN ─── top 50 docs ──┘
  │
  ├─ top rerank_top_k (20) by RRF score; RRF normalized by the max value
  │
  ├─ yes/no rerank via chat completions ········ llm_cache('rerank')
  │     4 parallel workers, candidate text truncated to 2,000 chars
  │
  └─ position-weighted blend → top `limit` hits (source: "hybrid")
```

### Query expansion (`--expand`)

`expandQuery()` (`src/core/search/expand.ts`) asks the generation model
(temperature 0.3) for two rephrasings and parses the first JSON array out of
the answer, deduplicating case-insensitively against the original and each
other (max 2 kept). The result is cached in `llm_cache` under purpose
`expand` keyed by the raw query, so repeat queries never re-hit the LLM.
In the fused candidate pool the **original query carries variant weight 2
and each expansion variant weight 1**, so expansion can only broaden — it
cannot outvote the user's own words. Expansion failures and the no-provider
case degrade to the original query only, with a warning.

### Candidate generation

For every variant, `hybridQuery` collects two ranked lists of up to
`CANDIDATE_LIMIT = 50` documents each:

- **FTS**: `keywordSearch()` with the active tokenizer (conventions below).
- **Vector**: `vectorSearchDetailed()` — chunk KNN aggregated per document
  (details below). The best chunk's text is kept alongside each hit so the
  reranker can judge the actual matching passage.

### RRF fusion

Per list, per rank (0-based array index):

```
contribution = listWeight × variantWeight / (rrf_k + rank + 1)
```

which is classic Reciprocal Rank Fusion `1/(k + r)` with 1-based rank `r`,
scaled by `listWeight` (`search.keyword_weight` / `search.vector_weight`,
both 1.0 by default) and the variant weight (2 or 1). Contributions
accumulate per `docId`; `rrf_k` comes from config (`search.rrf_k`, default
60). The fused pool is sorted by RRF score and cut to
`search.rerank_top_k` (default 20) candidates. RRF scores are then
**normalized by the maximum** (the top candidate's score) so the blend
operates on a 0–1 scale.

### Rerank

`rerankCandidates()` (`src/core/search/rerank.ts`) asks the reranker model a
yes/no question per candidate using the Qwen3-Reranker instruct format
(English system prompt — intentional, see
[llm-providers.md](llm-providers.md)):

- **Parallelism**: a worker pool of `CONCURRENCY = 4` shares one index.
- **Truncation**: candidate text is cut to `MAX_DOC_CHARS = 2000`.
- **Caching**: read-through `llm_cache` under purpose `rerank`, keyed by
  `query \x00 truncatedText` and the reranker model.
- **Parsing** (`parseYesNo`): strips Qwen3 `<think>…</think>` blocks,
  lowercases, and matches `\b(yes|no)\b` → 1 / 0; anything undecidable
  (including an empty answer) falls back to **0.5**. A candidate missing
  from the score map also blends with 0.5.

Candidates that only came from the keyword list have no chunk text attached;
`candidateText()` substitutes the document's first chunk, or
`# {title}\n\n` + the first 1,600 body characters when the document has no
chunks.

### Position-weighted blend

`blendScores()` trusts RRF more at the top of the RRF ranking:

| RRF rank | final score |
| --- | --- |
| 1–3 | `rrfNormalized × 0.75 + rerank × 0.25` |
| 4–10 | `rrfNormalized × 0.6 + rerank × 0.4` |
| 11+ | `rrfNormalized × 0.4 + rerank × 0.6` |

`rrfNormalized = rrfScore / maxRrf` (division by the pool maximum). The
final list is re-sorted by blended score and cut to `limit`
(`search.default_limit`, default 10). When the reranker is unavailable or
fails, the RRF-normalized score is the final score and RRF order stands.

### Degraded operation

Every LLM dependency degrades with a warning on stderr and exit 0:

- No provider at all → keyword-only results (`usedVector: false`) plus a
  warning pointing at `kura doctor`.
- `ensureEmbeddings` or the KNN query throws → warning, keyword-only.
- Rerank throws → warning, RRF order returned as-is (`usedRerank: false`).
- `--expand` without a provider or on failure → warning, original query only.

`tests/search.test.ts` and `tests/regression-search.test.ts` pin all of
these paths with a mock provider / `setProviderForTests(null)`.

## Answer generation (`kura ask`, not in SPEC)

`askQuestion()` (`src/core/search/ask.ts`) layers one generation step on top
of the hybrid pipeline and returns an `AskOutcome`
(`{ answer, sources, hits, warnings }`):

```
question
  │
  ├─ hybridQuery() ·········· full pipeline above, incl. --expand / degraded paths
  │
  ├─ top MAX_SOURCES (5) hits → numbered sources ····· "[n] # full/path/Title" +
  │     first MAX_SOURCE_CHARS (1,600) body characters each
  │
  └─ generation model, temperature 0.2 ·············· llm_cache('ask')
        answer strictly from the sources, cited as [1], [2], …
```

- **Prompt**: Japanese — an intentional Japanese product surface like the
  clip / tag / expand prompts ([llm-providers.md](llm-providers.md)). It
  instructs the model to answer only from the numbered 資料 blocks, to cite
  them as `[n]`, and to say the knowledge base has no answer rather than
  guess. Qwen3-style `<think>` blocks are stripped from the answer.
- **Sources vs hits**: `sources` are the up-to-5 documents shown to the
  model, in citation order (`[1]` = `sources[0]`); `hits` are the remaining
  hybrid hits beyond them. In degraded mode `sources` is empty and `hits`
  carries the full hybrid result.
- **Caching**: read-through `llm_cache` under purpose `ask`, keyed by
  `question \x00 key1:contentHash1,key2:contentHash2,…` and the generation
  model — editing any source document changes its `content_hash` and
  invalidates the cached answer.
- **Degraded operation** (invariants R4, exit 0 in all cases):
  - zero hybrid hits → `answer: null`, no LLM call;
  - no provider → `answer: null` plus a "cannot generate an answer without
    an LLM provider; showing search results only" warning;
  - generation throws → `answer: null` plus an "answer generation failed …"
    warning.
  The CLI then prints the hits exactly like `kura query`; the MCP tool
  returns the standard hits list.

`tests/ask.test.ts` pins the citation flow, cache invalidation by content
hash, and every degraded path with a mock provider.

## FTS query conventions (SPEC §5.4)

`keywordSearch()` (`src/core/search/keyword.ts`) builds one SQL statement
whose MATCH expression depends on the tokenizer recorded in `meta`
(see [native-extensions.md](native-extensions.md)):

- **vaporetto**: `documents_fts MATCH vaporetto_or_query(?)` with the raw
  user query bound; `--all` switches to `vaporetto_and_query(?)`. If the SQL
  fails with `no such function: vaporetto` / `no such tokenizer`, the error
  is rewrapped with a `kura doctor` hint.
- **trigram**: `buildTrigramQuery()` splits on whitespace, wraps each term
  in a `"..."` phrase (doubling embedded quotes), and joins with `OR`
  (`AND` for `--all`).
- **Ranking**: `bm25(documents_fts, 5.0, 1.0, 3.0, 5.0)` weights
  title / content / tags / aliases. Title is the strongest curated relevance
  signal (5×), aliases are alternate titles so they weigh the same (5×),
  tags are deliberate classification (3×), body text is the 1×
  baseline. bm25 is lower-is-better, so the hit score is its negation.
- **Snippets**: `snippet(documents_fts, 1, '**', '**', '…', 20)` — column 1
  (content), `**` highlight markers, `…` ellipsis, 20 tokens.
- **Filters**: bucket by name; tag matches the path or any descendant
  (`path = ? OR path LIKE ? || '/%'`).

### LIKE fallback for short trigram queries (not in SPEC)

The trigram tokenizer cannot index terms shorter than 3 characters, which
would make common one/two-character Japanese queries (e.g. `猫`) return
nothing. When the tokenizer is trigram, FTS returned **zero rows**, and at
least one term is shorter than 3 characters, `likeFallback()` runs a
`LIKE '%term%' ESCAPE '\'` scan over `title` and `content` (escaping
`\ % _`), joined with OR/AND per `--all`, ordered by `updated_at DESC` with
score 0, and builds a hand-rolled snippet (±40 chars around the first match,
`**` highlighted, newlines collapsed). This is a linear scan — acceptable at
the ~10k-doc design scale (see [performance.md](performance.md)). **This is
an implementation addition; see Deviations.**

## Chunking (SPEC §5.2)

`chunkDocument()` (`src/core/chunker.ts`) splits a Markdown body into
embedding-sized chunks. Empty / whitespace-only bodies produce no chunks;
bodies at or under the target size produce exactly one.

- **Target size** `TARGET_SIZE = 1600` characters (≈900–1000 Japanese
  tokens), **overlap** `OVERLAP = 240` (15%), **search window**
  `WINDOW = ±400` around `start + 1600`.
- **Breakpoint priorities** (base scores; candidates deduped keeping the
  max score per position):

| Breakpoint | Base score | Candidate position |
| --- | --- | --- |
| H1 heading | 100 | start of the heading line (split *before* it) |
| H2 heading | 90 | start of the heading line |
| H3 heading | 80 | start of the heading line |
| Code-fence boundary | 80 | fence-open line start and the line after the close |
| Horizontal rule | 60 | line after the rule |
| Blank line | 20 | following line start |
| Any line end | 1 | following line start |

- **Decay**: within the window, each candidate scores
  `finalScore = baseScore × (1 - (distance/400)² × 0.7)` where `distance`
  is the offset from the target position; ties break toward the nearer
  candidate. So a heading 300 chars away still beats a nearby blank line.
- **Code fences are never split**: no candidates are generated inside a
  fence (an unclosed fence extends to end-of-document). If no candidate
  exists in the window at all, the cut is forced at the target position —
  snapped out of a containing fence to the nearer boundary that still
  advances, and adjusted off UTF-16 surrogate pairs.
- **Overlap**: the next chunk starts at `end - 240`, snapped to the fence
  end if that lands inside a fence (keeping fence pairs intact per chunk),
  with a forward-progress guarantee (`next` falls back to `end` if it would
  not advance). Tests allow observed overlap up to 400 chars after
  adjustments.
- **Context header**: each chunk's `text` is
  `# {title}\n\n` + raw slice, or `# {title} > {nearest heading}\n\n` +
  raw slice, where the nearest H1–H3 at or before the chunk start supplies
  the heading (title-only when the chunk starts exactly at a heading). The
  header improves embedding retrieval accuracy. **The header is persisted in
  `chunks.text`** — `startOffset` always refers to the raw body position
  (UTF-16 offset, used for line jumps), and consumers that display chunk
  text (vector snippets) strip the first line back off.

Chunks are rebuilt inside the document-save transaction
(`rebuildChunks()` in `src/core/documents.ts`) whenever the content hash
*or the title* changes — the title is baked into every context header. The
rebuild deletes the document's `chunks_vec` rows and inserts fresh `chunks`
rows with `embedded_at = NULL`.

## Lazy embedding backfill (SPEC §5.3)

`add` / `edit` / `clip` / `import` never block on embedding generation:
they only write chunks with `embedded_at = NULL`. Embeddings appear via
(`src/core/search/vector.ts`):

- **`kura embed`** (`src/cli/commands/embed.ts`): `backfillEmbeddings()`
  processes pending chunks in batches of `EMBED_BATCH_SIZE = 16`; each batch
  is one `provider.embed()` call plus one transaction writing `chunks_vec`
  and stamping `embedded_at`. Because `embedded_at` is committed per batch,
  an interrupted run **resumes where it left off** — the pending set is
  simply `embedded_at IS NULL`. After a run the command records
  `embedding_model` / `embedding_dimensions` in `meta` so `doctor` can
  detect model drift (see [self-healing.md](self-healing.md)).
- **`kura embed --all`**: clears `chunks_vec` entirely and nulls every
  `embedded_at`, then regenerates everything (for model changes).
- **Automatic pre-search backfill**: `ensureEmbeddings()` runs before every
  vector or hybrid search. Zero pending → proceed. Pending
  ≤ `AUTO_BACKFILL_LIMIT = 100` → silent full backfill. Pending > 100 →
  return a warning ("N chunk(s) are not embedded yet … run 'kura embed'")
  and search anyway with the embeddings that exist. Callers: the `vsearch`
  command, `hybridQuery`, `/api/search?mode=vector`, and `kura audit`.
- **Dimension mismatch**: if the provider returns vectors whose length
  differs from `llm.models.embedding_dimensions`, the batch transaction
  aborts with an error pointing at `kura embed --all`. The `chunks_vec`
  table's dimension is fixed at creation; an actual model/dimension change
  is handled by `doctor`'s `recreateVecIfModelChanged()`
  (`src/core/doctor.ts`), which drops and recreates the table.

## Vector search (`kura vsearch` and the hybrid vector leg)

`vectorSearchDetailed()` (`src/core/search/vector.ts`):

1. Embed the query (single-text `provider.embed()` call).
2. KNN over `chunks_vec`: `WHERE embedding MATCH ? AND k = ?` with
   **`k = max(limit × 4, 40)`**. The headroom exists because multiple chunks
   of one document collapse into a single hit and because bucket/tag filters
   are applied *after* the KNN (so heavy filtering can return fewer than
   `limit` documents).
3. Aggregate per document: rows arrive distance-ascending, so the first row
   seen per `documents.id` is its **minimum-distance chunk**; aggregation
   stops once `limit` documents are collected.
4. Score: `1 / (1 + distance)` (higher is better).
5. Snippet: the best chunk's text with the context header (first line)
   stripped, whitespace collapsed, truncated to 160 chars + `…`.

Query and chunk vectors are bound as BLOBs: a `Float32Array` is passed as a
`Uint8Array` view over the same buffer (`toBlob()`), which sqlite-vec
accepts as a float32 vector for both `INSERT` and `MATCH`.

The `vsearch` command itself uses `requireProvider` (exit 4 without a
provider) and prints the `ensureEmbeddings` warning to stderr when the
backlog is large.

Search is not the only KNN consumer: `kura audit` reuses `chunks_vec` to
pair each recent chunk's stored vector with its nearest cross-document
neighbours as contradiction candidates (`src/core/audit.ts`; see
[cli-reference.md](cli-reference.md) for the pipeline).

## Deviations from SPEC

1. **LIKE fallback for sub-3-character trigram queries** — an
   implementation addition not present in SPEC §5.4, required to make
   short Japanese queries usable on trigram databases (see above).
2. **No idle background backfill in servers** — SPEC §5.3 item 3 planned
   idle-time embedding work while `kura browser` / `kura mcp` run. Not
   implemented: servers backfill only on demand through
   `ensureEmbeddings()` before vector/hybrid searches (`src/server/api.ts`),
   plus the explicit `kura embed`.
3. **Context header persisted in `chunks.text`** — SPEC §5.2 describes the
   header as "prepended before embedding"; the implementation stores
   header + body in the `text` column. `startOffset` still points at the
   raw body position, and vector snippets strip the header back off.
4. **Rerank confidence is discrete** — SPEC §2 mentions using logprobs for
   confidence "when available"; the implementation never requests logprobs
   and scores strictly 1 / 0 / 0.5 from the yes/no answer text (see
   [llm-providers.md](llm-providers.md)).
5. **`kura ask` is an addition** — SPEC §5 defines retrieval only; the
   answer-generation stage (`askQuestion`, the `ask` cache purpose, the
   `kura_ask` MCP tool) is implementation-defined (see above).

## Related docs

- [llm-providers.md](llm-providers.md) — provider detection, `llm_cache`,
  degradation matrix
- [data-model.md](data-model.md) — `chunks`, `chunks_vec`, `documents_fts`
  schema and sync rules
- [performance.md](performance.md) — measured latencies against SPEC §13
- [testing.md](testing.md) — Japanese fixture requirements for search tests
