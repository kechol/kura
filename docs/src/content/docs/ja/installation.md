---
title: インストール
description: Homebrew またはプリビルドバイナリで kura を導入し、任意の LLM モデルを準備してナレッジベースを初期化します。
---

kura はプラットフォームごとに単一の自己完結バイナリとして配布されます。
自分の環境に合う方法を選んでください。

## Homebrew（macOS / Linux）

```sh
brew install kechol/tap/kura
```

この formula は Homebrew の `sqlite` keg に依存します。これは macOS で
重要です。Apple 純正の SQLite は kura の検索が依存する拡張をロード
できないため、kura は `/opt/homebrew/opt/sqlite` の Homebrew ビルドを
使います。Homebrew がそれを入れてくれます。

あとで更新する場合:

```sh
brew update && brew upgrade kura
```

## プリビルドバイナリ

[Releases](https://github.com/kechol/kura/releases) から対象
プラットフォームのアーカイブをダウンロードします。

- macOS: `kura-darwin-arm64.tar.gz` / `kura-darwin-x64.tar.gz`
- Linux: `kura-linux-x64.tar.gz` / `kura-linux-arm64.tar.gz`
- Windows: `kura-windows-x64.zip`

各アーカイブにはインストーラーが同梱されています。

```sh
tar xzf kura-darwin-arm64.tar.gz
./install.sh   # kura を ~/.local/bin にコピーし、macOS の quarantine 属性を除去
```

ダウンロードはリリースページの `SHA256SUMS.txt` で検証してください。

macOS では引き続き Homebrew の SQLite が必要です。

```sh
brew install sqlite
```

## 任意: ローカル LLM モデル

セマンティック検索・リランク・`kura clip` の整形は、ローカル LLM
プロバイダを使います。[Ollama](https://ollama.com/)（または
LM Studio）を入れて、既定のモデルを取得します。

```sh
ollama pull qwen3-embedding:0.6b          # embedding（1024 次元）
ollama pull dengcao/Qwen3-Reranker-0.6B   # リランク
ollama pull qwen3:4b                      # 生成（clip・タグ提案・クエリ展開）
```

3 つとも 32GB Mac で同時ロードできるサイズです。モデルは
`kura config` で変更できます。[設定](/kura/ja/configuration/) を
参照してください。

プロバイダが無ければ、kura はキーワードのみの検索へ劣化します。
始めるにあたって必須のものはここにはありません。

## 初期化

```sh
kura init      # ~/.kura の作成、トークナイザーのダウンロード、DB 作成
kura doctor    # SQLite / 拡張 / LLM プロバイダ / DB 整合性を診断
```

`kura init` は日本語形態素解析トークナイザー（sqlite-vaporetto、
モデル同梱、約 6.5MB）を GitHub Releases から SHA256 検証付きで取得
します。未対応のプラットフォーム（darwin-x64 など）では trigram
トークナイザーへ自動でフォールバックします。

`kura doctor` は、何かおかしいと感じたときに走らせる健全性チェックです。
`kura doctor --fix` はインデックスの修復やリンクの再解決などを行います。

## ブラウザ UI

```sh
kura browser        # http://127.0.0.1:7578 （127.0.0.1 のみにバインド）
```

ドキュメント閲覧（Markdown レンダリング・バックリンク・2 ホップ
リンク）、その場編集、3 モード検索、ドキュメント path に沿った
サイドバーのツリー表示、タグブラウザ、d3-force による
ナレッジグラフを、すべてローカルで提供します。UI はサイドバーで
選んだ 1 つの Bucket にスコープされます。開き直すと最後に読んでいた
ドキュメントを再開し、ホーム画面は閲覧履歴です。Ctrl+P で即時検索、
Ctrl+N で新規ドキュメント、統計画面では件数・embedding カバレッジ・
整理のヒントを確認できます。★を付けたドキュメントはサイドバー上部に
固定表示され、その配下のドキュメントを折りたたみツリーとして展開
できます。UI のテキストは日本語です。

## データの保存場所

すべて `~/.kura/` の下にあります。

- `kura.db` — SQLite ストア（ドキュメント・検索インデックス・
  embedding）。
- `config.toml` — 設定（`kura config`）。
- ダウンロードした拡張とトークナイザーモデル。

データディレクトリは `KURA_HOME` で、特定の DB ファイルは `KURA_DB`
で上書きできます。[設定](/kura/ja/configuration/) を参照してください。
