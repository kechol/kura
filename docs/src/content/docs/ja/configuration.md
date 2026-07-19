---
title: 設定
description: config.toml、LLM モデル設定、そして kura のデータ保存先とプロバイダを制御する環境変数。
---

kura は `~/.kura/config.toml` を読み込みます。直接編集するか、
`kura config` を使います。

```sh
kura config list
kura config get llm.provider
kura config set general.stale_days 90
```

## `config.toml`

```toml
[general]
default_bucket = "main"
editor = ""           # kura edit が開くコマンド。空なら $EDITOR → vi
stale_days = 180

[llm]
provider = "auto"     # auto | ollama | lmstudio | none
ollama_url = "http://localhost:11434"
lmstudio_url = "http://localhost:1234"

[llm.models]
embedding = "qwen3-embedding:0.6b"
embedding_dimensions = 1024
reranker = "dengcao/Qwen3-Reranker-0.6B"
generation = "qwen3:4b"

[search]
rrf_k = 60
keyword_weight = 1.0
vector_weight = 1.0
rerank_top_k = 20
default_limit = 10

[clip]
path = "clips"

[browser]
port = 7578
```

### `[general]`

| キー | 意味 |
|---|---|
| `default_bucket` | Bucket を指定しないときに新規ドキュメントが入る先 |
| `editor` | `kura edit` が開くコマンド。空なら `$EDITOR`、次に `vi` |
| `stale_days` | この日数だけ触れられていないドキュメントは陳腐化候補（`kura ls --stale`） |

### `[llm]`

`provider` はローカル LLM バックエンドを選びます。

- `auto` — まず Ollama、次に LM Studio を試す（既定）。
- `ollama` / `lmstudio` — バックエンドを固定する。
- `none` — LLM 機能を完全に無効化。kura はキーワードのみで動く。

`ollama_url`（既定 `http://localhost:11434`）と `lmstudio_url`（既定
`http://localhost:1234`）は各バックエンドの接続先です。既定以外の
ホストやポートに向けるときに変更します。

### `[llm.models]`

kura がプロバイダに要求するモデルです。既定は 32GB Mac で同時に
動かせる小ささです。

| キー | 用途 |
|---|---|
| `embedding` | セマンティック検索・ハイブリッド検索のベクトル |
| `embedding_dimensions` | ベクトルの次元。embedding モデルと一致させる |
| `reranker` | `kura query` のリランク |
| `generation` | `kura clip` の整形、クエリ展開、`kura ask` の回答生成、`kura triage` / `kura audit` の LLM ステップ（タイトル・タグ提案、重複・リンク判定、矛盾チェック） |

:::caution
embedding モデルまたはその次元を変更したら、`kura doctor --fix`
（変更の検出）に続けて `kura embed` を実行し、すべてのベクトルを
新しい次元で再生成してください。古いベクトルはモデル間で互換性が
ありません。
:::

### `[search]`

ハイブリッド検索のチューニング。既定でたいていのストアに合います。

| キー | 意味 |
|---|---|
| `rrf_k` | キーワードとベクトルの結果を融合する際の RRF 定数 |
| `keyword_weight` / `vector_weight` | 融合時の各リストの重み |
| `rerank_top_k` | ローカル LLM がリランクする融合後候補の数 |
| `default_limit` | `--limit` 省略時の結果件数 |

### `[clip]`

| キー | 意味 |
|---|---|
| `path` | 新しいクリップを保存するドキュメント path（既定 `clips`）。`""` にすると Bucket のルートに保存 |

### `[browser]`

| キー | 意味 |
|---|---|
| `port` | `kura browser` が待ち受けるポート（既定 `7578`）。`--port` で上書き |

## 環境変数

| 変数 | 効果 |
|---|---|
| `KURA_HOME` | データディレクトリ（既定 `~/.kura`） |
| `KURA_DB` | DB ファイルのパス。`KURA_HOME/kura.db` を上書き |
| `NO_COLOR` | 色付き CLI 出力を無効化 |

`KURA_HOME` は、複数のナレッジベースを分けて持つきれいな方法です。
プロジェクトや文脈ごとに別のディレクトリを指せば、それぞれが独立した
SQLite ストアと設定を持ちます。
