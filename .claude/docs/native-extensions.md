# Native SQLite extensions

> Covers SPEC §2 (§2.1–§2.2). Key sources: `src/core/bootstrap.ts`,
> `src/core/db.ts`, `src/core/paths.ts`, `src/core/migrations/001_init.sql`,
> `src/cli/commands/init.ts`, `tests/db.test.ts`.

kura depends on two native SQLite extensions:

- **sqlite-vec** (`vec0` virtual table) — vector KNN search. **Required.**
  Every database open loads it; failure is fatal.
- **sqlite-vaporetto** — Japanese morphological FTS5 tokenizer. **Optional.**
  When it cannot be loaded, FTS falls back to the built-in `trigram`
  tokenizer (degraded but functional Japanese search).

Native `.dylib` / `.so` / `.dll` files cannot be `dlopen`'d from inside a
Bun single binary, which drives most of the design below: extensions are
materialized on the real filesystem under `~/.kura/lib/<kura version>/`
(`libDir()` in `src/core/paths.ts`; the per-version directory means upgrades
never fight over stale artifacts) and loaded from there.

## Homebrew SQLite on macOS

Apple's bundled SQLite is compiled without extension-loading support, so
`loadExtension()` cannot work against it — Bun must be pointed at Homebrew's
SQLite instead via `Database.setCustomSQLite()`.

- **Timing constraint**: `setCustomSQLite()` only takes effect **before the
  first `Database` instance is created in the process**, and must be called
  once. `setupSqlite()` in `src/core/db.ts` enforces this with a module-level
  guard flag; it is a no-op on non-macOS platforms and on repeat calls.
  This is why **all connections must be opened through `openDatabase()` /
  `getDb()` in `src/core/db.ts`** — code that constructs a raw
  `new Database(...)` first (as `kura doctor`'s probe checks do) must call
  `setupSqlite()` itself.
- **Arch-specific paths** (`brewSqlitePath()`):
  - arm64: `/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib`
  - x64: `/usr/local/opt/sqlite/lib/libsqlite3.dylib`
- When the dylib is missing, `setupSqlite()` silently skips the override and
  the subsequent sqlite-vec load fails; the error message and the
  `homebrew-sqlite` doctor check both point to `brew install sqlite`
  (see [self-healing.md](self-healing.md)).

## sqlite-vec (required)

`vecLoadablePath()` in `src/core/bootstrap.ts` resolves the extension in two
modes, keyed off the generated module `src/generated/embedded.ts`
(see [build-and-release.md](build-and-release.md)):

- **Development** (`bun run dev`): the stub `embedded.ts` exports
  `embeddedVecLib = null`, so the path comes from the npm package's
  `getLoadablePath()` — the prebuilt binary that `bun install` placed under
  `node_modules` for the current platform.
- **Compiled binary**: `embedded.ts` was regenerated at compile time to embed
  the platform's prebuilt (`vec0.dylib` / `vec0.so` / `vec0.dll`) via
  `import ... with { type: "file" }`. Because dlopen cannot read from the
  embedded virtual filesystem, `vecLoadablePath()` copies the asset out to
  `~/.kura/lib/<ver>/<name>` on first use (idempotent: skipped when the file
  already exists) and returns that real path.

The prebuilt version is pinned in `scripts/fetch-vendor.ts` (`VEC_VERSION`);
dev builds use whatever `sqlite-vec` version `package.json` resolves.

## sqlite-vaporetto (optional)

### Pinned release and assets

`src/core/bootstrap.ts` pins `VAPORETTO_VERSION = "v0.4.0"` and downloads
**`-with-model` builds** from the upstream GitHub Releases — the morphological
model (`bccwj-suw+unidic_pos+kana.model.zst`) is compiled into the shared
library itself, so there is exactly one artifact per platform and no separate
model file on disk.

| Platform key | Release asset | Library file |
| --- | --- | --- |
| `darwin-arm64` | `sqlite-vaporetto-v0.4.0-macos-aarch64-with-model.tar.gz` | `libsqlite_vaporetto.dylib` |
| `linux-x64` | `sqlite-vaporetto-v0.4.0-linux-x86_64-with-model.tar.gz` | `libsqlite_vaporetto.so` |
| `linux-arm64` | `sqlite-vaporetto-v0.4.0-linux-aarch64-with-model.tar.gz` | `libsqlite_vaporetto.so` |
| `win32-x64` | `sqlite-vaporetto-v0.4.0-windows-x86_64-with-model.zip` | `sqlite_vaporetto.dll` |

Each asset has a hard-coded SHA256 constant in `VAPORETTO_ASSETS`; bumping
`VAPORETTO_VERSION` means recomputing all four hashes. `darwin-x64` has no
entry — see the platform matrix below.

The library file name does not follow SQLite's default entry-point derivation,
so `loadExtension()` is always called with the explicit entry point
`sqlite3_vaporetto_init` (`VAPORETTO_ENTRY_POINT`).

### Download and verification flow (`ensureVaporetto`)

Runs during `kura init` and `kura doctor --fix` (never implicitly on other
commands — this is one of the few sanctioned network accesses, see
`CLAUDE.md`). Steps:

1. Return early with the existing path if `~/.kura/lib/<ver>/<lib>` is
   already present, or `null` on unsupported platforms / when `download`
   is disabled (`kura init --no-download`).
2. Download the archive into a per-PID temp work dir (120 s timeout,
   `User-Agent: kura-cli`).
3. Compute SHA256 and compare against the pinned constant; **mismatch throws**
   and nothing is installed.
4. Extract with `tar -xf` (bsdtar handles both `.tar.gz` and `.zip`, and
   ships on Windows 10+), verify the library exists inside the archive's
   top-level directory.
5. `rename` the library into `libDir()` (created on demand); the temp dir is
   removed in a `finally` block, so a failed run leaves no partial state.

`kura init` treats a download failure as a warning, not an error: the DB is
still created with the trigram tokenizer and the message says to rerun
`kura init` later. `tests/db.test.ts` exercises the full
download → SHA256 → load → Japanese tokenization path behind
`KURA_TEST_DOWNLOAD=1` (enabled in CI).

## Platform support matrix

| Target | vaporetto | Notes |
| --- | --- | --- |
| darwin-arm64 | yes | first-class (primary development target) |
| linux-x64 | yes | CI runs the real download/load test here |
| linux-arm64 | yes | |
| windows-x64 | yes | best effort |
| darwin-x64 | **no → trigram fallback** | upstream publishes no binary |

`vaporettoSupported()` is simply "is `${platform}-${arch}` a key of
`VAPORETTO_ASSETS`", so adding a platform is a one-entry change (plus its
SHA256).

## Tokenizer decision flow

The FTS5 tokenizer is decided **once per database** and persisted in the
`meta` table (`fts_tokenizer`); the migration template
`src/core/migrations/001_init.sql` substitutes it into
`tokenize='{{FTS_TOKENIZE}}'`.

- **Fresh DB** (`PRAGMA user_version` = 0): `openDatabase()` picks
  `vaporetto` if the extension actually loaded in this process, otherwise
  `trigram`, runs the migration with that tokenizer, and records
  `fts_tokenizer`, `embedding_model`, and `embedding_dimensions` in `meta`.
- **Existing DB**: `meta.fts_tokenizer` is authoritative (defaulting to
  `trigram` when absent); the current environment never silently changes it.
  If meta says `vaporetto` but the extension failed to load, a warning is
  emitted ("searches may fail, run kura doctor") — queries against a
  vaporetto-built FTS table without the tokenizer loaded error out.
- **Upgrade path**: when a DB was built with `trigram` but vaporetto has
  since become loadable, `kura doctor` warns (`fts-tokenizer` check) and
  `kura doctor --fix` re-creates the FTS table with the vaporetto tokenizer
  and reindexes every document (`retokenizeFts` in `src/core/doctor.ts` —
  details in [self-healing.md](self-healing.md)).

## Runtime load order (`openDatabase`)

1. `setupSqlite()` (macOS Homebrew override, before any `Database`).
2. `new Database(path)`; `PRAGMA journal_mode=WAL`, `foreign_keys=ON`,
   `busy_timeout=15000` (wait out transient WAL write-lock contention —
   concurrent writers or a slow/loaded filesystem — instead of erroring
   with "database is locked").
3. **sqlite-vec — required.** On failure the connection is closed and an
   error is thrown with a platform-appropriate hint (macOS:
   `brew install sqlite`; elsewhere: `kura doctor`). Nothing downstream can
   work without `chunks_vec`.
4. **sqlite-vaporetto — optional.** Loaded (with the explicit entry point)
   only if the file exists; a load failure downgrades to a warning and the
   trigram fallback. Tests pass `vaporettoPath: null` to force-disable it
   deterministically.
5. Migration + tokenizer/meta reconciliation as described above.

## Deviations from SPEC

- **`-with-model` builds instead of a separate model download.** SPEC §2.1
  described downloading the extension *and* the morphological model
  (`bccwj-suw+unidic_pos+kana.model.zst`) as separate artifacts, with the
  FTS table declared as
  `tokenize='vaporetto model {KURA_HOME}/lib/{ver}/bccwj-....model.zst'`
  (SPEC §3.1). The implementation uses upstream's `-with-model` archives,
  which embed the model in the dylib/so/dll: one artifact, one SHA256, and a
  plain `tokenize='vaporetto'` declaration with no filesystem path baked into
  the schema — the DB file stays portable across machines and `KURA_HOME`
  locations.
- **sqlite-vec extraction is lazy, not "on first launch".** SPEC §2.1 said
  the embedded vec extension is extracted on first launch; in practice
  `vecLoadablePath()` extracts on any database open when the file is missing
  (functionally equivalent, but it also self-heals if the user deletes
  `~/.kura/lib/`).

## Related docs

- [build-and-release.md](build-and-release.md) — how the vec prebuilt gets
  embedded per target, `src/generated/embedded.ts` codegen
- [self-healing.md](self-healing.md) — doctor checks for every item above,
  `--fix` re-download and retokenization
- [data-model.md](data-model.md) — `meta` keys, FTS/vec table definitions
