# Performance

> Covers SPEC §13. Key sources: SPEC targets plus ad-hoc measurements on the
> reference machine; `tests/regression-search.test.ts` (latency smoke test),
> `src/core/search/*`, `src/core/documents.ts`.

## Targets and measured results

Measured **2026-07-08** on an Apple Silicon Mac, Bun 1.3.11, **trigram**
tokenizer, 10,000 synthetic Japanese documents unless noted:

| Item | SPEC §13 target | Measured | Status |
| --- | --- | --- | --- |
| `kura search` (10k docs) | < 100 ms | `keywordSearch()` median 3.3–3.9 ms across query mixes, p90 ≤ 4.1 ms | pass, ~25× headroom |
| `kura vsearch` (10k docs ≈ 30k–50k chunks) | < 500 ms (incl. query embedding) | — not yet measured | pending |
| `kura query` (incl. rerank) | < 5 s | — not yet measured | pending |
| `kura add`, one document (excl. embedding) | < 200 ms | mean 3.57 ms/doc over the 10,000-doc ingest | pass |
| Startup overhead (incl. extension loading) | < 300 ms | warm start ~40 ms; a full `kura search` invocation including startup ~38 ms | pass |
| Binary size | < 100 MB (vaporetto model excluded) | 60.3 MB (darwin-arm64) | pass |

Supplementary datapoint (no SPEC target): the database file reached
**72.8 MB** at 10k synthetic documents — comfortable for the "standard, not
contentless FTS table" trade-off accepted in SPEC §3.1.

`kura add` includes the full repository-layer transaction (FTS upsert, link
extraction, tag sync, chunk rebuild) — embeddings are excluded by design
because chunks are backfilled lazily
(see [search-pipeline.md](search-pipeline.md)).

## Not yet measured

- **`kura vsearch` (< 500 ms)** and **`kura query` (< 5 s)** need a real
  local provider (Ollama with `qwen3-embedding:0.6b` /
  `dengcao/Qwen3-Reranker-0.6B`); the test suite deliberately uses a mock
  provider (see [testing.md](testing.md)), so no honest end-to-end numbers
  exist yet. The dominant costs will be model inference (query embedding,
  up to 20 rerank calls at concurrency 4) plus the brute-force KNN over
  30k–50k chunk vectors — the SQLite side is not expected to be the
  bottleneck at this scale.
- All measurements above used the **trigram** tokenizer. vaporetto changes
  indexing cost and match quality, but the `kura search` target has ~25×
  headroom, so no regression is expected; re-validate when a vaporetto
  benchmark run happens.

## Reproducing the benchmark

The benchmark script is **not committed to the repository** — the numbers
above come from a throwaway script. The procedure, for re-runs:

1. Point `KURA_HOME` / `KURA_DB` at a temp directory (never `~/.kura`) and
   open the DB via `openDatabase()` with the trigram tokenizer.
2. Ingest 10,000 synthetic Japanese documents through `createDocument()`
   (`src/core/documents.ts`), timing each call; report the mean for the
   `kura add` row.
3. Run `keywordSearch()` a few times as **warmup**, then measure **10
   timed runs** per query and take the median and p90.
4. DB size: the `.db` file size after ingest (WAL checkpointed). Binary
   size: `bun run compile` output for the current platform. Startup: time a
   trivial command end-to-end (e.g. `kura search` against the warm OS page
   cache).

`tests/regression-search.test.ts` contains a permanent "latency smoke"
test (a single `keywordSearch` under 300 ms on the 30-document fixture set)
that guards against gross regressions in CI without turning the suite into
a benchmark.

## Scale characteristics and caveats

- **Design scale is ~10k documents** (SPEC §1.1); scaling past 100k is an
  explicit non-goal (SPEC §1.2, [roadmap.md](roadmap.md)).
- **trigram's 3-character constraint**: terms shorter than 3 chars cannot
  hit the FTS index, so `keywordSearch` falls back to a `LIKE` scan — a
  linear pass over all documents that stays cheap at 10k docs but is the
  first thing to degrade beyond the design scale
  (see [search-pipeline.md](search-pipeline.md)).
- **sqlite-vec `vec0` KNN is brute force**: query cost is linear in the
  number of chunk vectors (`k = max(limit × 4, 40)` neighbors over
  30k–50k × 1024-dim float32 at design scale). No ANN index exists or is
  planned for v1; quantization/partitioning are out of scope.
- The BM25 query is index-bound (FTS5 posting lists plus per-hit tag
  subqueries); the measured medians barely move between 3-char and longer
  queries, which is why the p90 stays ≤ 4.1 ms at 10k docs.

## Deviations from SPEC

- None. The §13 targets are adopted unchanged; `vsearch` / `query` remain
  unverified against their targets until a real-provider benchmark run
  (tracked above), which is a measurement gap, not a behavioral deviation.

## Related docs

- [search-pipeline.md](search-pipeline.md) — what each measured code path does
- [testing.md](testing.md) — why CI cannot produce the vsearch/query numbers
- [build-and-release.md](build-and-release.md) — how the measured binary is built
