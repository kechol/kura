# Configuration

> Covers SPEC §11. Key sources: `src/core/config.ts`, `src/core/paths.ts`,
> `src/core/db.ts` (meta), `src/cli/commands/config.ts`,
> `src/cli/commands/doctor.ts`.

Configuration lives in `~/.kura/config.toml` (more precisely
`$KURA_HOME/config.toml`, `src/core/paths.ts::configPath`). `kura init`
writes the defaults if the file is absent; every other command works with an
absent file by running on pure defaults. `loadConfig` parses with
`Bun.TOML.parse`, merges onto `defaultConfig()`, and caches the result **per
process** — `saveConfig` and the test helper `resetConfigCache` invalidate
the cache.

## Key reference

The schema is the `KuraConfig` interface in `src/core/config.ts`; defaults
are `defaultConfig()` and match SPEC §11 exactly (verified by
`tests/config.test.ts`).

| Key | Type | Default | Meaning / effect of changing it |
| --- | --- | --- | --- |
| `general.default_bucket` | string | `"main"` | Write target for `add` / `clip` / `import` when neither `--bucket` nor frontmatter names one. `bucket rm` refuses to delete this bucket. Changing it does **not** move documents; point it at an existing bucket. |
| `general.editor` | string | `""` | First entry in the editor resolution chain (below). Empty means "fall through". Split on whitespace, so `"code --wait"` works. |
| `general.stale_days` | number | `180` | Staleness horizon: `ls --stale` / `status` / the browser home only consider documents whose `updated_at` is older, and the score normalizes age by this value (`src/core/stale.ts`). Lowering it surfaces more review candidates immediately; nothing is ever deleted. |
| `llm.provider` | `"auto" \| "ollama" \| "lmstudio" \| "none"` | `"auto"` | `auto` probes Ollama then LM Studio (`src/core/llm/provider.ts`, result cached in-process for 60 s). A named provider is used only if reachable. `none` disables all LLM features: `vsearch`/`embed`/`tag suggest` exit 4, `query`/`clip`/`tag audit` degrade with warnings. |
| `llm.ollama_url` | string | `"http://localhost:11434"` | Probed via `GET /api/tags`; also what `doctor` checks and where the model inventory comes from. |
| `llm.lmstudio_url` | string | `"http://localhost:1234"` | Probed via `GET /v1/models`. |
| `llm.models.embedding` | string | `"qwen3-embedding:0.6b"` | Embedding model for chunk/query vectors. **Changing it invalidates every stored vector**: `doctor` warns on the meta mismatch, `doctor --fix` recreates `chunks_vec` and NULLs `embedded_at`, then `kura embed` regenerates (see the meta section below). |
| `llm.models.embedding_dimensions` | number | `1024` | Dimension of the `vec0` table column. Same change procedure as the model; additionally `backfillEmbeddings` hard-fails if the provider returns vectors of a different length, with guidance to fix config and run `kura embed --all`. Must match the model (e.g. switch both when moving to `kun432/cl-nagoya-ruri-large`). |
| `llm.models.reranker` | string | `"dengcao/Qwen3-Reranker-0.6B"` | yes/no relevance judge in `kura query` (`src/core/search/rerank.ts`). Change takes effect on the next query; rerank results are cached in `llm_cache` keyed by model, so no invalidation is needed. |
| `llm.models.generation` | string | `"qwen3:4b"` | Used for clip formatting, tag suggestion, and query expansion (`src/core/clip/format.ts`, `src/core/search/expand.ts`). Cache keys include the model. |
| `search.rrf_k` | number | `60` | RRF constant: each list contributes `weight / (rrf_k + rank + 1)` (`src/core/search/hybrid.ts`). |
| `search.keyword_weight` | number | `1.0` | Multiplier for the FTS candidate list in RRF fusion. |
| `search.vector_weight` | number | `1.0` | Multiplier for the KNN candidate list in RRF fusion. |
| `search.rerank_top_k` | number | `20` | How many fused candidates go to the reranker (also bounds the final result pool of `query`). |
| `search.default_limit` | number | `10` | Default `--limit` for `kura query` (and the hybrid path generally). `search`/`vsearch` default to a hard-coded 20 instead. |
| `browser.port` | number | `7578` | `kura browser` listen port; on EADDRINUSE the server retries +1 up to 10 times (`src/server/http.ts`). `--port` overrides per invocation. |

## `kura config` behavior

`src/cli/commands/config.ts` operates on the merged config (defaults +
file), addressed by dotted keys:

- `list` prints every leaf as `key = value` (values JSON-encoded);
  `--json` dumps the whole merged object. Defaults appear even when the file
  doesn't contain them — `list` shows *effective* config, not file content.
- `get <key>` prints the value (`--json` for JSON encoding; whole sections
  print as JSON objects). Unknown keys are `NotFoundError` → **exit 3**.
- `set <key> <value>` mutates the merged config and rewrites the file.
  `setConfigValue` only accepts **existing** keys and **preserves the
  current value's type**: numeric keys reject non-numeric input, boolean
  keys accept only `true`/`false`, everything else is stored as a string.
  Unknown keys or type-invalid values are `NotFoundError` → exit 3.
- Because `set` re-serializes the merged config (`serializeConfig`), the
  file is normalized on every write: **comments and unknown keys in a
  hand-edited config.toml are dropped** the first time `kura config set`
  runs. The serializer emits nested sections (`[llm.models]`) and only knows
  the schema.

Parsing is deliberately forgiving (`mergeInto`): unknown keys are ignored,
and a value whose TOML type doesn't match the default's type is discarded in
favor of the default (e.g. `stale_days = "not-a-number"` silently stays
180). A config file that fails to parse at all is reported by `doctor` as a
failed check; other commands surface the parse error.

## Environment variables

| Variable | Effect | Precedence |
| --- | --- | --- |
| `KURA_HOME` | Relocates the whole data directory: DB, `config.toml`, `lib/<version>/` extensions (`src/core/paths.ts`). Default `~/.kura`. | Highest for everything path-related except the DB file when `KURA_DB` is set. |
| `KURA_DB` | Overrides **only** the DB file path; `:memory:` is allowed and additionally bypasses the `getDb()` "run kura init first" existence check (`src/core/db.ts`). | Beats `$KURA_HOME/kura.db`. |
| `NO_COLOR` | Any non-empty value disables ANSI escapes in TTY rendering (`src/cli/render.ts::isColorEnabled`); layout is unaffected. Empty string counts as unset. | Beats TTY detection. |
| `EDITOR` | Second entry in the editor chain (below). | After `general.editor`, before `vi`. |

Blank (whitespace-only) `KURA_HOME`/`KURA_DB` values are treated as unset.

Test usage patterns (see [testing.md](testing.md) for the full picture):
e2e tests run each scenario in `KURA_HOME=$(mktemp -d)` after
`kura init --no-download`; unit tests use `KURA_DB=:memory:` or pass
`{path: ":memory:"}` straight to `openDatabase`; in-process tests that touch
env vars back them up in `beforeEach` and restore in `afterEach`, calling
`resetConfigCache()` on both sides (`tests/db.test.ts` is the reference
implementation). Never point tests at the real `~/.kura`.

## Config vs meta

`config.toml` records the **desired** state; the `meta` table
(`src/core/db.ts::getMeta/setMeta`) records the **actual** state of the
database. `doctor` is the reconciler.

| meta key | Written by | Meaning |
| --- | --- | --- |
| `fts_tokenizer` | `openDatabase` on first creation; `retokenizeFts` on reindex | Tokenizer `documents_fts` was actually built with (`vaporetto` / `trigram`). Reopening trusts meta, not the current environment: a vaporetto-built DB opened without the extension only warns. |
| `embedding_model` | `openDatabase` (fresh DB), `kura embed` (after success), `recreateVecIfModelChanged` | Model whose vectors are actually stored in `chunks_vec`. |
| `embedding_dimensions` | same as above | Dimension `chunks_vec` was created with. Reopen-time migrations use the meta value, not config, so an existing table never silently changes shape. |

Reconciliation flows:

- **Embedding drift**: config model/dimensions ≠ meta → `doctor` warns
  (`embedding-model` check) → `doctor --fix` runs
  `recreateVecIfModelChanged` (drops/recreates `chunks_vec` with the new
  dimensions, NULLs all `embedded_at`, updates meta) → `kura embed`
  repopulates. Running `kura embed --all` alone re-embeds but does **not**
  resize the vec table — the `--fix` step is what handles a dimension
  change.
- **Tokenizer drift**: vaporetto becomes loadable on a trigram-built DB →
  `doctor` warns (`fts-tokenizer` check) → `doctor --fix` calls
  `retokenizeFts(db, "vaporetto")` which rebuilds the FTS table and updates
  meta.
- The schema version is **not** a meta key: it is `PRAGMA user_version`,
  managed by the migration runner in `src/core/db.ts`.

## Editor resolution

Used only by `kura edit` (`src/cli/commands/edit.ts`):

1. `general.editor` from config, if non-blank;
2. `$EDITOR`, if non-blank;
3. `vi`.

The chosen string is whitespace-split into command + args and spawned with
inherited stdio; a non-zero exit aborts the edit and keeps the temp file.

## Deviations from SPEC

- **`schema_version` is not stored in `meta`.** SPEC §3.1 lists it among the
  meta keys; the implementation tracks schema state with
  `PRAGMA user_version` instead (`src/core/db.ts::schemaVersion`).
- **`kura config set` normalizes the file**, dropping comments and unknown
  keys (SPEC doesn't specify write-back semantics).
- **Unknown-key handling is split**: reads/parses ignore unknown keys
  silently (merge-onto-defaults), while `config get`/`set` reject them with
  exit 3. SPEC §11 doesn't define either behavior; both are intentional
  (forward compatibility for files, typo protection for the CLI).
