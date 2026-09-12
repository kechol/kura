# Performance

> Covers SPEC §13. Key sources: `scripts/benchmark.ts`,
> `tests/regression-search.test.ts`, `src/core/search/*`, and
> `src/core/documents.ts`.

## Targets and measured results

Measured **2026-09-12** on an Apple Silicon Mac with Bun 1.4.2 and the
**trigram** tokenizer. An isolated baseline checkout at
`48c7bd7bbc302981b4f49f11d71569f7cb4727ee` and the working tree each ran five
trials over the same 10,000 deterministic Japanese documents. Every trial used
three warmups and ten timed samples; the table reports the median across those
five trial summaries.

| Item | SPEC §13 target | Baseline → final | Status |
| --- | --- | --- | --- |
| `kura search` (`全文検索`, p90) | < 100 ms | 12.470 → 5.858 ms | pass |
| `kura search` (`トランザクション`, p90) | < 100 ms | 10.016 → 8.737 ms | pass |
| `kura search` (`形態素解析`, p90) | < 100 ms | 7.476 → 7.778 ms | pass |
| `kura vsearch` | < 500 ms incl. query embedding | no live provider run | pending |
| `kura query` | < 5 s incl. rerank | no live provider run | pending |
| CRUD create, 20-item batch | < 200 ms/document | median 8.958 → 9.651 ms; p90 10.259 → 10.965 ms | pass |
| CLI startup | < 300 ms | median 22.553 → 22.670 ms; p90 25.258 → 26.922 ms | pass |
| Binary size | < 100 MB | 64,208,370 → 64,241,394 bytes (+0.05%) | pass |

The WAL-checkpointed database size was identical at **73,601,024 bytes**.
Mean ingest time was 6.126 → 5.341 ms/document, but the first pair was heavily
affected by host load (the baseline ingest took 195.7 s, versus 44.5–66.7 s in
later trials). These numbers establish absence of a reproduced regression;
they do not claim that the dependency update caused an improvement.

`形態素解析` median latency increased 11.00%, while its p90 increased only
4.04% and the keyword hot-path source is identical between revisions. It is
retained as an observation rather than a stable regression. The comparison
gate treats scalar metrics at +10% as regressions and latency distributions as
regressions only when both median and p90 reproduce +10%; every individual
+10% statistic still remains in the JSON observations.

## Not yet measured

- **`kura vsearch` (< 500 ms)** and **`kura query` (< 5 s)** require a real
  local provider. No model was downloaded or invoked for this comparison, so
  mock timings are not presented as end-to-end results.
- The measured data path used **trigram**. The real sqlite-vaporetto
  download/load/Japanese-tokenization behavior is covered separately by the
  opt-in integration test, not by this performance run.

## Reproducing the benchmark

`scripts/benchmark.ts` owns the repeatable contract. It always uses a temporary
`KURA_HOME` and `KURA_DB` (deleted even on failure unless `--keep-temp` is
explicit), deterministic Japanese data, no LLM provider, and a checkpointed
database.

For each isolated revision, compile a host binary and run five trials:

```sh
bun run scripts/benchmark.ts \
  --label baseline \
  --revision 48c7bd7bbc302981b4f49f11d71569f7cb4727ee \
  --binary /path/to/baseline-kura \
  --output /path/to/baseline-1.json \
  --documents 10000 --warmup 3 --runs 10
```

Repeat with distinct outputs for all baseline and final trials, then compare:

```sh
bun run scripts/benchmark.ts \
  --baseline-result /path/to/baseline-1.json \
  --baseline-result /path/to/baseline-2.json \
  --baseline-result /path/to/baseline-3.json \
  --baseline-result /path/to/baseline-4.json \
  --baseline-result /path/to/baseline-5.json \
  --final-result /path/to/final-1.json \
  --final-result /path/to/final-2.json \
  --final-result /path/to/final-3.json \
  --final-result /path/to/final-4.json \
  --final-result /path/to/final-5.json \
  --output /path/to/comparison.json
```

Run mode exits 0 on success and 1 on invalid input or an execution failure.
Compare mode validates environment/document/chunk compatibility and exits 2
when a reproduced regression crosses the policy above, otherwise 0.

`tests/regression-search.test.ts` remains a small CI latency smoke test. It
guards against gross regressions but is not substituted for the 10k benchmark.

## Scale characteristics and caveats

- **Design scale is ~10k documents** (SPEC §1.1); scaling past 100k is an
  explicit non-goal (SPEC §1.2, [roadmap.md](roadmap.md)).
- **trigram's 3-character constraint**: shorter terms use a linear `LIKE`
  fallback that is cheap at 10k documents but is the first keyword path likely
  to degrade beyond the design scale.
- **sqlite-vec `vec0` KNN is brute force**. Bucket/tag-eligible chunk IDs are
  filtered inside the KNN query; candidate count begins at
  `max(limit × 4, 40)` and expands only when duplicate chunks leave too few
  unique documents. No ANN index is planned for v1.

## Deviations from SPEC

- None. The §13 targets are unchanged. `vsearch` and `query` remain explicitly
  unverified until a real-provider benchmark is run.

## Related docs

- [search-pipeline.md](search-pipeline.md) — what each measured code path does
- [testing.md](testing.md) — why CI cannot produce live-provider timings
- [build-and-release.md](build-and-release.md) — how the measured binary is built
