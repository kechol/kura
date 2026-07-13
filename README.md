# kura

[日本語版 README はこちら](README.ja.md)

A local knowledge management CLI that stores Markdown/HTML documents in SQLite
and makes them queryable by both humans and AI agents.

📖 **Documentation**: <https://kechol.github.io/kura/>

- **Japanese-aware hybrid search**: keyword search with FTS5 +
  [sqlite-vaporetto](https://github.com/hotchpotch/sqlite-vaporetto)
  (morphological analysis), semantic search with
  [sqlite-vec](https://github.com/asg017/sqlite-vec) + local embeddings, and
  local-LLM reranking
- **Self-organizing**: no forced filing. Documents organize themselves
  through buckets, hierarchical tags (`tech/db/sqlite`), and wiki links
  (`[[Title]]`); an optional document path (`db/sqlite`) adds a folder-like
  name when you want one, and the bucket root works as an inbox
- **AI agent integration**: an MCP server (`kura mcp`) and `--json` output on
  every read command
- **Browser UI**: document viewer/editor and a knowledge graph
  (`kura browser`)
- **Fully local**: your data lives in a single SQLite file at
  `~/.kura/kura.db`. Ollama / LM Studio are auto-detected; without them,
  keyword search still works (graceful degradation)

## Installation

### Homebrew (macOS, Linux)

```sh
brew install kechol/tap/kura
```

The formula depends on the Homebrew `sqlite` keg, which kura needs on macOS
(Apple's bundled SQLite cannot load extensions) — Homebrew installs it for you.

### Prerequisites (non-Homebrew)

- **macOS**: Homebrew SQLite is required (Apple's bundled SQLite cannot load
  extensions)

  ```sh
  brew install sqlite
  ```

- **LLM features (optional)**: [Ollama](https://ollama.com/) or LM Studio.
  Without a provider, kura degrades to keyword-only search

### Binary

Download the archive for your platform from [Releases](../../releases)
(`kura-<platform>.tar.gz`, or `.zip` on Windows) and verify it against
`SHA256SUMS.txt`:

```sh
tar xzf kura-*.tar.gz && ./install.sh   # also removes the macOS quarantine attribute
```

### Initialize

```sh
kura init      # create ~/.kura, download extensions, create the DB
kura doctor    # diagnose SQLite / extensions / LLM providers / DB integrity
```

`kura init` downloads the Japanese morphological tokenizer
(sqlite-vaporetto with a bundled model, ~6.5 MB) from GitHub Releases with
SHA256 verification. On unsupported platforms (e.g. darwin-x64) it falls back
to the trigram tokenizer automatically.

### Pull LLM models (for semantic search, reranking, and clip formatting)

```sh
ollama pull qwen3-embedding:0.6b          # embeddings (1024 dimensions)
ollama pull dengcao/Qwen3-Reranker-0.6B   # reranker
ollama pull qwen3:4b                      # generation (clip cleanup, tag suggestion, query expansion)
```

All three fit comfortably in memory on a 32 GB Mac. Models are configurable
via `kura config`.

## Quick start

```sh
# Add documents
kura add notes/sqlite-wal.md --tags tech/db/sqlite
echo "# Note body" | kura add - --title "Today's note"
kura clip https://example.com/article        # capture a web page, cleaned up by the LLM (filed under clips/)

# Search (three modes)
kura search "WAL checkpoint"          # keyword (FTS5 BM25, < 100ms)
kura vsearch "how writes stay readable"   # semantic (KNN)
kura query "SQLite concurrency"       # hybrid + rerank (best quality)

# View & edit
kura get "Today's note"        # by doc key, #key, full path, or unique title
kura edit "Today's note"       # edit in $EDITOR (frontmatter edits title/path/tags too)
kura mv "Today's note" --path db/sqlite   # optional document path; [[links]] follow
kura ls --tag tech/db --sort updated
kura ls --prefix db            # documents under a path prefix (descendants included)

# Links & tags
kura link ls "Today's note"    # outlinks / backlinks / 2-hop links
kura link broken               # unresolved links
kura tag ls --tree
kura tag suggest --untagged --apply   # LLM tag suggestions (reuses your existing taxonomy)
kura tag audit                 # merge candidates for similar tags, oversized-tag warnings

# Maintenance
kura status                    # stats (embedding coverage, stale candidates, ...)
kura ls --stale                # long-untouched, rarely-read documents
kura doctor --fix              # index repair, link re-resolution, and more
kura export --dir backup/      # write Markdown with frontmatter (paths become subdirectories)
kura import backup/            # round-trips via kura_key (subdirectories become paths)
```

Notation inside documents:

- `[[Title]]` / `[[Title|display text]]` — wiki links. **Write the link first
  and it connects automatically when the page is created later.** If two
  documents share a title, `[[db/sqlite/Title]]` (full path) pins the link to
  one of them
- `#tech/db/sqlite` — hierarchical tags (extracted on save)

## AI agent integration (MCP)

```sh
claude mcp add kura -- kura mcp     # Claude Code
kura mcp --print-config             # snippet for .mcp.json
```

Exposed tools: `kura_query` (hybrid search), `kura_search`, `kura_get`,
`kura_add`, `kura_update`, `kura_list_tags`, `kura_related`, `kura_status`.
`kura_add` / `kura_update` accept an optional document `path`, and `kura_get`
also resolves a full path (`clips/Title`).

Every read command also supports machine-readable output via `--json`.

## Browser UI

```sh
kura browser        # http://127.0.0.1:7578 (binds to 127.0.0.1 only)
```

Document viewer (rendered Markdown, backlinks, 2-hop links), editor,
three-mode search, a sidebar document tree following your document paths,
tag browser, and a d3-force knowledge graph (colored by tag, stale nodes
dimmed). Pick a bucket in the sidebar and the whole UI — browsing, search,
trees, graph — stays inside it; the choice is remembered. Opening kura
resumes the document you were last reading, and the home screen lists your
reading history. The statistics screen counts what needs tidying (unfiled,
untagged and orphaned documents, broken links, duplicate-looking tags) and
names the command that fixes each. The UI text is currently Japanese.

## Configuration

`~/.kura/config.toml` (read/write via `kura config list|get|set`):

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
path = "clips"        # document path new clips are filed under ("" = bucket root)
```

Environment variables: `KURA_HOME` (data directory, default `~/.kura`),
`KURA_DB` (DB path override), `NO_COLOR`.

After changing the embedding model, run `kura doctor --fix` and then
`kura embed` to regenerate vectors.

## Development

```sh
bun install
bun run dev -- --help    # run the CLI from source
bun test                 # tests (set KURA_TEST_DOWNLOAD=1 to include the real vaporetto download test)
bun run check            # typecheck + lint
bun run compile          # single binary for the current platform
```

Architecture and subsystem documentation live in
[.claude/docs/](.claude/docs/README.md). See [CLAUDE.md](CLAUDE.md) for
contribution conventions, including the bilingual documentation policy.

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in the work by you, as defined in the Apache-2.0
license, shall be dual licensed as above, without any additional terms or
conditions.
