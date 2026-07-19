---
title: Installation
description: Install kura via Homebrew or a prebuilt binary, set up the optional LLM models, and initialize your knowledge base.
---

kura ships as a single self-contained binary per platform. Pick the
route that fits your system.

## Homebrew (macOS, Linux)

```sh
brew install kechol/tap/kura
```

The formula depends on the Homebrew `sqlite` keg. This matters on
macOS: Apple's bundled SQLite cannot load the extensions kura's search
relies on, so kura uses the Homebrew build at
`/opt/homebrew/opt/sqlite`. Homebrew installs it for you.

To upgrade later:

```sh
brew update && brew upgrade kura
```

## Prebuilt binary

Download the archive for your platform from
[Releases](https://github.com/kechol/kura/releases):

- macOS: `kura-darwin-arm64.tar.gz` / `kura-darwin-x64.tar.gz`
- Linux: `kura-linux-x64.tar.gz` / `kura-linux-arm64.tar.gz`
- Windows: `kura-windows-x64.zip`

Each archive bundles an installer:

```sh
tar xzf kura-darwin-arm64.tar.gz
./install.sh   # copies kura to ~/.local/bin and clears the macOS quarantine flag
```

Verify downloads against `SHA256SUMS.txt` on the release page.

On macOS you still need Homebrew SQLite:

```sh
brew install sqlite
```

## Optional: local LLM models

Semantic search, reranking, and `kura clip` formatting use a local LLM
provider. Install [Ollama](https://ollama.com/) (or LM Studio) and pull
the default models:

```sh
ollama pull qwen3-embedding:0.6b          # embeddings (1024 dimensions)
ollama pull dengcao/Qwen3-Reranker-0.6B   # reranker
ollama pull qwen3:4b                      # generation (clip, tag suggestion, query expansion)
```

All three fit comfortably in memory on a 32 GB Mac. You can change the
models with `kura config` — see [Configuration](/kura/configuration/).

Without a provider, kura degrades to keyword-only search; nothing here
is strictly required to start.

## Initialize

```sh
kura init      # create ~/.kura, download the tokenizer, create the DB
kura doctor    # diagnose SQLite / extensions / LLM providers / DB integrity
```

`kura init` downloads the Japanese morphological tokenizer
(sqlite-vaporetto with a bundled model, ~6.5 MB) from GitHub Releases
with SHA256 verification. On platforms it doesn't support (e.g.
darwin-x64), it falls back to the trigram tokenizer automatically.

`kura doctor` is the health check to run any time something looks off;
`kura doctor --fix` repairs the index, re-resolves links, and more.

## The browser UI

```sh
kura browser        # http://127.0.0.1:7578 (binds to 127.0.0.1 only)
```

A document viewer (rendered Markdown, backlinks, two-hop links),
in-place editing, three-mode search, a sidebar document tree that
follows your document paths, a tag browser, and a d3-force knowledge
graph — all served locally. The UI is scoped to one bucket at a time,
picked in the sidebar. A fresh visit resumes the document you last
read, and the home screen is your reading history. The UI can be driven
entirely from the keyboard, Gmail/GitHub-style: Ctrl+P (or `/`) opens
instant search, Ctrl+N (or `c`) starts a new document, `g`-prefixed keys
jump between screens, `j` / `k` walk any list, and `?` shows the full
shortcut list. A Statistics screen surfaces
counts, embedding coverage, and tidying suggestions. Star a document
and it stays pinned at the top of the sidebar, with whatever is filed
under it expanding beneath it. The UI text is Japanese.

## Where your data lives

Everything is under `~/.kura/`:

- `kura.db` — the SQLite store (documents, search indexes, embeddings).
- `config.toml` — configuration (`kura config`).
- downloaded extensions and the tokenizer model.

Override the data directory with `KURA_HOME`, or point at a specific
database file with `KURA_DB`. See [Configuration](/kura/configuration/).
