# Build and release

> Covers SPEC §12 (§12.1). Key sources: `package.json`, `scripts/build-html.ts`,
> `scripts/compile.ts`, `scripts/fetch-vendor.ts`, `scripts/package-release.ts`,
> `scripts/gen-formula.ts`, `scripts/install.sh`, `scripts/install.ps1`,
> `src/generated/embedded.ts`, `.github/workflows/ci.yml`,
> `.github/workflows/release.yml`, `.github/workflows/docs.yml`,
> `.github/workflows/dependabot-auto-merge.yml`, `.github/dependabot.yml`.

## Development commands

| Command | What it does |
| --- | --- |
| `bun run dev -- <args>` | Run the CLI from source (`src/cli/index.ts`), e.g. `bun run dev -- doctor` |
| `bun test` | Full test suite (in-memory / temp-dir DBs via `KURA_HOME` / `KURA_DB`; never the real `~/.kura`) |
| `KURA_TEST_DOWNLOAD=1 bun test tests/db.test.ts` | Additionally runs the real vaporetto download + load integration test |
| `bun run check` | `tsc --noEmit` + `biome check src` — the CI gate |
| `bun run build:client` | SPA build via `scripts/build-html.ts` into `dist/` |
| `bun run compile` | Single binary for the current platform via `scripts/compile.ts` |
| `bun run scripts/fetch-vendor.ts [targets...]` | Prefetch sqlite-vec prebuilts into `vendor/` (all five targets when omitted) |
| `bun run scripts/package-release.ts` | Archive compiled binaries + installers into `release/kura-<platform>.{tar.gz,zip}` and write `release/SHA256SUMS.txt` (expects `release/<bun-target>/` populated) |
| `bun run scripts/gen-formula.ts <tag>` | Generate the Homebrew formula (`release/kura.rb`) from `release/SHA256SUMS.txt` for the given tag |

`dist/`, `vendor/`, `release/`, and the root `kura` binary are all gitignored
and reproducible; nothing generated is committed.

## SPA build (`scripts/build-html.ts`)

`Bun.build` bundles `src/client/index.tsx` (target `browser`, minified, no
sourcemaps) into `dist/` with **fixed, hash-free artifact names**:
`index.js`, `index.css`, `index.html`. The CSS output is normalized to
`index.css` (renaming Bun's emitted artifact, or copying
`src/client/styles.css` when Bun emits none), `index.html` is copied verbatim,
and the script fails the build if any of the three artifacts is missing.

Fixed names matter because both the dev asset resolver in
`src/server/http.ts` and the compile-time embedded asset table address files
by literal path — content hashing would break the embedding codegen and buys
nothing for a localhost-only server.

## Single-binary pipeline (`scripts/compile.ts`)

`bun run compile` (optionally `--target bun-<os>-<arch> --outfile <path>`)
runs five stages:

1. **SPA build** — invokes `scripts/build-html.ts` (above).
2. **Vendor fetch** — invokes `scripts/fetch-vendor.ts <target>` so the
   sqlite-vec prebuilt for the *compile target* (not the host) exists under
   `vendor/sqlite-vec/<bun-target>/`.
3. **Codegen of `src/generated/embedded.ts`** — writes a module that imports
   every non-`.map` file in `dist/` plus the target's vec library with
   `import ... with { type: "file" }`, and exports:
   `embeddedAssets` (URL path → embedded file path), `embeddedVecLib`, and
   `embeddedVecLibName`. `with { type: "file" }` specifiers must be static
   string literals, which is why this is code generation rather than a
   runtime loop — the asset list has to exist as source text before
   `bun build --compile` runs.
4. **Compile** — `bun build src/cli/index.ts --compile --target=<bun-target>
   --minify-whitespace --minify-syntax --outfile=<out>`. Bun appends `.exe`
   automatically for the windows target.
5. **Stub restore** — a `finally` block writes the pre-build content back to
   `embedded.ts` (or the canonical stub, if the backup itself was a generated
   file, detected via its `DO NOT EDIT` marker). The working tree is left
   clean even when the compile fails.

### The `embedded.ts` stub

In development `src/generated/embedded.ts` is a committed stub: empty
`embeddedAssets`, `embeddedVecLib = null`. Its two consumers branch on that:

- `src/server/http.ts` serves SPA assets from the repo's `dist/` when the
  embedded map is empty, from the embedded files otherwise.
- `src/core/bootstrap.ts` (`vecLoadablePath()`) resolves sqlite-vec from
  `node_modules` in dev, or extracts the embedded library to
  `~/.kura/lib/<ver>/` in a compiled binary (dlopen cannot read the embedded
  virtual FS — see [native-extensions.md](native-extensions.md)).

It lives in `src/generated/` — outside `core/`, `server/`, `cli/`, and
`client/` — because it is consumed by both the core layer (vec extension) and
the server layer (SPA assets); a layer-neutral location keeps the codegen
surface to exactly one file and avoids either layer importing from the other.

## Vendor prebuilts (`scripts/fetch-vendor.ts`)

`bun install` only unpacks the sqlite-vec *optional dependency* matching the
running platform, so cross-compiling five targets on one CI runner needs the
other four prebuilts fetched explicitly. `fetch-vendor.ts` downloads the
npm registry tarball for each requested target
(`sqlite-vec-darwin-arm64`, `-darwin-x64`, `-linux-x64`, `-linux-arm64`,
`-windows-x64`, pinned to `VEC_VERSION = 0.1.9`), extracts only the library
file (`vec0.dylib` / `vec0.so` / `vec0.dll`) with
`tar --strip-components=1`, and caches it under
`vendor/sqlite-vec/<bun-target>/` (idempotent: existing files are skipped).
`VENDOR_TARGETS` is also the authoritative list of supported compile targets
— `compile.ts` rejects anything not in it.

This is build-time-only network access from the npm registry, one of the few
sanctioned network calls (see `CLAUDE.md`). Note it fetches **sqlite-vec
only**; sqlite-vaporetto is downloaded at *runtime* by
`src/core/bootstrap.ts`, never at build time.

## Release workflow (`.github/workflows/release.yml`)

Triggered by pushing a `v[0-9]+.[0-9]+.[0-9]+*` tag (the maintainer's manual
step after the `/release` bump PR merges); runs on `ubuntu-latest`, with the
`release` job granted `contents: write`:

1. Checkout + `setup-bun` pinned to **1.3.11** (see CI below) +
   `bun install --frozen-lockfile`.
2. **Cross-compile all five targets** in a loop:
   `bun run scripts/compile.ts --target <t> --outfile release/<t>/kura`
   (Bun emits `kura.exe` for `bun-windows-x64`).
3. **Package** — `scripts/package-release.ts` stages each binary with the
   matching installer (`install.sh` / `install.ps1`) plus the licenses and
   README, then archives them as `release/kura-<platform>.tar.gz`
   (`.zip` for windows; platform = bun target minus the `bun-` prefix, binary
   at the archive root) and writes `release/SHA256SUMS.txt`.
4. **Formula** — `scripts/gen-formula.ts <tag>` reads `SHA256SUMS.txt` and
   emits `release/kura.rb` pointing at the release download URLs.
5. **Publish** — `gh release create <tag> --generate-notes` with the archives,
   `SHA256SUMS.txt`, and `kura.rb` (marked `--prerelease` when the tag has a
   `-` suffix, e.g. `v0.2.0-rc.1`).
6. **Homebrew tap** — for a stable tag, and only when the `HOMEBREW_TAP_TOKEN`
   secret is configured, the workflow clones `kechol/homebrew-tap`, copies
   `kura.rb` to `Formula/kura.rb`, and pushes. The token is a fine-grained PAT
   with contents-write on the tap repo. Without the secret the step is skipped
   (not failed), so a fork without it still publishes a normal GitHub Release.

The formula is `kura` (`brew install kechol/tap/kura`) and declares
`depends_on "sqlite"` — on macOS kura loads SQLite extensions, which Apple's
bundled SQLite cannot do, so it needs the Homebrew keg at
`/opt/homebrew/opt/sqlite` (docs: native-extensions.md).

### Installers

- `scripts/install.sh` (POSIX): copies `kura` to `$KURA_INSTALL_DIR`
  (default `~/.local/bin`), `chmod +x`, and on macOS **removes the
  `com.apple.quarantine` attribute** so Gatekeeper does not block the
  unsigned binary; it also reminds the user that Homebrew SQLite is required
  and prints a PATH hint plus `next: kura init`.
- `scripts/install.ps1` (Windows): copies `kura.exe` to
  `$env:KURA_INSTALL_DIR` (default `%LOCALAPPDATA%\kura`) with the same
  PATH / `kura init` hints.

## CI (`.github/workflows/ci.yml`)

Runs on every PR and push to `main`:

- **`check`** job (ubuntu): `bun install --frozen-lockfile` + `bun run check`
  (`tsc --noEmit` + `biome check src`).
- **`test`** job, matrix `ubuntu-latest` × `macos-latest`. On Linux, `bun test`
  runs with **`KURA_TEST_DOWNLOAD=1`** so the real vaporetto download → SHA256
  → dlopen → Japanese tokenization integration test in `tests/db.test.ts`
  executes on linux-x64. On macOS the job first runs `brew install sqlite`
  (extension loading needs the Homebrew keg) and then a plain offline
  `bun test`, exercising the macOS `setupSqlite()` path.

All Bun jobs pin **Bun 1.3.11**: newer/canary Bun builds hit a `dlopen`
regression (oven-sh/bun#30717) that breaks `loadExtension()`, which would
take down every native-extension code path. Bump the pin only after
verifying extension loading on the new version (SPEC §2 calls this out as a
hard requirement).

## Docs site (`.github/workflows/docs.yml`)

The Astro Starlight site under `docs/` (English root + Japanese `ja/` mirror)
builds on every `main` push (smoke test) and on `vX.Y.Z` tag pushes. Pages
deployment fires only for tag refs (and a manual `workflow_dispatch` with
`publish=true`), so the published site at
`https://kechol.github.io/kura/` tracks tagged releases, not the rolling
`main` branch. The site is built with Bun (`bun install` + `bun run build`,
non-frozen — no lockfile is committed for the docs site).

## Dependency automation

`.github/dependabot.yml` watches three ecosystems (github-actions at the root,
npm at `/` for the Bun deps, npm at `/docs` for the Astro site).
`.github/workflows/dependabot-auto-merge.yml` enables auto-merge (squash) for
patch / minor and security bumps once the required CI checks pass; major bumps
fall through to a human reviewer.

## Binary size

Measured: the compiled `darwin-arm64` binary is **~60 MB**, well under the
SPEC §13 target of 100 MB. The embedded payload is the SPA `dist/` assets
plus one sqlite-vec prebuilt; sqlite-vaporetto (extension + embedded
morphological model) is deliberately *not* embedded and is downloaded at
runtime (see [native-extensions.md](native-extensions.md)).

## Deviations from SPEC

- **Codegen pipeline instead of the naive compile script.** SPEC §12.1
  specified `"compile": "bun run build && bun build src/cli/index.ts
  --compile --outfile=kura"`. That cannot embed assets: `with { type:
  "file" }` imports must be static literals, and cross-compiles need a
  target-specific vec prebuilt. `scripts/compile.ts` replaces it with the
  five-stage build → fetch-vendor → codegen → compile → stub-restore
  pipeline described above; `package.json`'s `compile` script now just calls
  it.
- **`build:client` is a script, not a raw `bun build` invocation.** SPEC
  §12.1 had `bun build src/client/index.tsx --outdir=dist --minify`;
  the implementation wraps it in `scripts/build-html.ts` to normalize
  artifact names, copy `index.html`, and hard-fail on missing artifacts.
- **`fetch-vendor.ts` scope narrowed.** SPEC §12's layout described it as a
  "dev helper: fetch sqlite-vaporetto / vec". It only handles sqlite-vec
  prebuilts for cross-compilation; vaporetto acquisition moved entirely to
  runtime bootstrap (`kura init` / `kura doctor --fix`), keeping build
  artifacts model-free.

## Related docs

- [native-extensions.md](native-extensions.md) — what happens to the embedded
  vec library at runtime; vaporetto download flow
- [browser-ui.md](browser-ui.md) — the SPA that `build-html.ts` bundles
- [testing.md](testing.md) — test policy behind `bun test` / CI
- [performance.md](performance.md) — size and latency targets vs. measurements
