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
stale_days = 180

[llm]
provider = "auto"     # auto | ollama | lmstudio | none

[llm.models]
embedding = "qwen3-embedding:0.6b"
embedding_dimensions = 1024
reranker = "dengcao/Qwen3-Reranker-0.6B"
generation = "qwen3:4b"
```

### `[general]`

| キー | 意味 |
|---|---|
| `default_bucket` | Bucket を指定しないときに新規ドキュメントが入る先 |
| `stale_days` | この日数だけ触れられていないドキュメントは陳腐化候補（`kura ls --stale`） |

### `[llm]`

`provider` はローカル LLM バックエンドを選びます。

- `auto` — まず Ollama、次に LM Studio を試す（既定）。
- `ollama` / `lmstudio` — バックエンドを固定する。
- `none` — LLM 機能を完全に無効化。kura はキーワードのみで動く。

### `[llm.models]`

kura がプロバイダに要求するモデルです。既定は 32GB Mac で同時に
動かせる小ささです。

| キー | 用途 |
|---|---|
| `embedding` | セマンティック検索・ハイブリッド検索のベクトル |
| `embedding_dimensions` | ベクトルの次元。embedding モデルと一致させる |
| `reranker` | `kura query` のリランク |
| `generation` | `kura clip` の整形、タグ提案、クエリ展開 |

:::caution
embedding モデルまたはその次元を変更したら、`kura doctor --fix`
（変更の検出）に続けて `kura embed` を実行し、すべてのベクトルを
新しい次元で再生成してください。古いベクトルはモデル間で互換性が
ありません。
:::

## 環境変数

| 変数 | 効果 |
|---|---|
| `KURA_HOME` | データディレクトリ（既定 `~/.kura`） |
| `KURA_DB` | DB ファイルのパス。`KURA_HOME/kura.db` を上書き |
| `NO_COLOR` | 色付き CLI 出力を無効化 |

`KURA_HOME` は、複数のナレッジベースを分けて持つきれいな方法です。
プロジェクトや文脈ごとに別のディレクトリを指せば、それぞれが独立した
SQLite ストアと設定を持ちます。
