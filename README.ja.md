# kura

[English README is here](README.md)

Markdown/HTML ドキュメントを SQLite に格納し、人間と AI エージェントの双方がクエリーできるローカルナレッジ管理 CLI。

📖 **ドキュメント**: <https://kechol.github.io/kura/ja/>

- **日本語対応ハイブリッド検索**: FTS5 + [sqlite-vaporetto](https://github.com/hotchpotch/sqlite-vaporetto)（形態素解析）によるキーワード検索、[sqlite-vec](https://github.com/asg017/sqlite-vec) + ローカル embedding によるセマンティック検索、ローカル LLM によるリランク
- **自己組織化**: ファイリングの強制なし。Bucket + 階層タグ（`tech/db/sqlite`）+ 相互リンク（`[[タイトル]]`）で整理。フォルダ風の名前が欲しいときだけ任意のドキュメント path（`db/sqlite`）を付けられ、Bucket のルートは inbox として使える
- **AI エージェント連携**: `kura mcp`（MCP サーバー）と読み取りコマンドの `--json` 出力
- **ブラウザ UI**: ドキュメント閲覧・編集・ナレッジグラフ可視化（`kura browser`）
- **ローカル完結**: データは `~/.kura/kura.db` の単一 SQLite。LLM は Ollama / LM Studio を自動検出（無くてもキーワード検索は動作）

## インストール

### Homebrew（macOS / Linux）

```sh
brew install kechol/tap/kura
```

この formula は Homebrew の `sqlite` keg に依存します。macOS では kura の拡張ロードに必要（Apple 純正 SQLite は拡張ロード不可）で、Homebrew が一緒に入れてくれます。

### 前提条件（Homebrew を使わない場合）

- **macOS**: Homebrew の SQLite が必要（Apple 純正 SQLite は拡張ロード不可のため）

  ```sh
  brew install sqlite
  ```

- **LLM 機能（任意）**: [Ollama](https://ollama.com/) または LM Studio。無い場合はキーワード検索のみの劣化動作

### バイナリ

[Releases](../../releases) から対象プラットフォームのアーカイブ（`kura-<platform>.tar.gz`、Windows は `.zip`）をダウンロードし、`SHA256SUMS.txt` で検証して展開:

```sh
tar xzf kura-*.tar.gz && ./install.sh   # macOS では quarantine 属性も除去される
```

### 初期化

```sh
kura init      # ~/.kura の作成、拡張のダウンロード、DB 作成
kura doctor    # 環境診断（SQLite / 拡張 / LLM プロバイダ / DB 整合性）
```

`kura init` は日本語形態素解析トークナイザー（sqlite-vaporetto、モデル同梱で約 6.5MB）を GitHub Releases から SHA256 検証付きでダウンロードします。未対応環境（darwin-x64 等）では自動的に trigram トークナイザーへフォールバックします。

### LLM モデルの準備（セマンティック検索・リランク・clip 整形に使用）

```sh
ollama pull qwen3-embedding:0.6b          # embedding（1024 次元）
ollama pull dengcao/Qwen3-Reranker-0.6B   # リランク
ollama pull qwen3:4b                      # 生成（clip 整形・タグ提案・クエリ展開）
```

すべて 32GB Mac で同時ロード可能なサイズです。モデルは `kura config` で変更できます。

## クイックスタート

```sh
# 追加
kura add notes/sqlite-wal.md --tags tech/db/sqlite
echo "# メモ本文" | kura add - --title "今日のメモ"
kura clip https://example.com/article        # Web ページを整形して取り込み（clips/ に保存）

# 検索（3 モード）と質問
kura search "WAL チェックポイント"           # キーワード（FTS5 BM25、< 100ms）
kura vsearch "書き込み中も読める仕組み"      # セマンティック（KNN）
kura query "SQLite の並行性"                 # ハイブリッド + リランク（最高精度）
kura ask "WAL は reader をブロックする？"    # 出典付きで回答（[1], [2] … で引用）

# 閲覧・編集
kura get "今日のメモ"          # doc_key / #key / フルパス / 一意なタイトル / 別名で指定
kura get "今日のメモ" --as-of 2026-03-01   # その時点の内容を表示
kura edit "今日のメモ"         # $EDITOR で編集（frontmatter でタイトル・パス・タグも変更可）
kura history "今日のメモ"      # 編集のたびに直前の版を保存。show / restore で表示・復元
kura mv "今日のメモ" --path db/sqlite   # 任意のドキュメント path を付ける（[[リンク]] も追従）
kura ls --tag tech/db --sort updated
kura ls --prefix db            # パスプレフィックス配下を一覧（子孫を含む）

# リンクとタグ
kura link ls "今日のメモ"      # アウトリンク / バックリンク / 2ホップ
kura link broken               # 未解決リンク一覧
kura alias add "今日のメモ" デイリーノート   # 別名: [[デイリーノート]] が解決され、検索にもヒット
kura tag ls --tree
kura tag suggest --untagged --apply   # LLM がタグ提案（既存タグ体系を優先）
kura tag audit                 # 類似タグの統合提案・巨大タグの検出

# メンテナンス
kura status                    # 統計（embedding カバレッジ・陳腐化候補など）
kura ls --stale                # 長期未更新 & 低参照のドキュメント
kura doctor --fix              # インデックス修復・未解決リンク再解決など
kura export --dir backup/      # frontmatter 付き Markdown で書き出し（パスはサブディレクトリになる）
kura import backup/            # kura_key でラウンドトリップ（サブディレクトリはパスになる）
```

本文中の記法:

- `[[タイトル]]` / `[[タイトル|表示名]]` — 相互リンク。**先にリンクを書いておけば、後からページを作ったときに自動で繋がります**。タイトルが重複するときは、フルパス（`[[db/sqlite/タイトル]]`）でリンク先を 1 つに固定できます。`kura alias add` の別名も本来のタイトルと同じように解決されるため、表記ゆれや略称が同じドキュメントに集まります
- `#tech/db/sqlite` — 階層タグ（保存時に自動抽出）

## AI エージェント連携

```sh
claude mcp add kura -- kura mcp     # Claude Code
kura mcp --print-config             # .mcp.json 用スニペット
kura skills install                 # エージェントスキル（CLI ガイド）→ ~/.agents/skills
```

MCP ツール: `kura_query`（ハイブリッド検索）, `kura_ask`（出典付き回答）, `kura_search`, `kura_get`, `kura_add`, `kura_update`, `kura_list_tags`, `kura_related`, `kura_status`

`kura_add` / `kura_update` は任意の `path` / `aliases` パラメータを受け付け、`kura_get` はフルパス（`clips/タイトル`）や一意な別名でも解決できます。

CLI で操作するエージェント向けには、`kura skills install` で `kura-cli` スキル（シェルから kura を操作するためのガイド）を `~/.agents/skills` にインストールできます（`--dir` でプロジェクトのスキルディレクトリも指定可。`show` で内容表示、`uninstall` で削除）。すべての読み取りコマンドは `--json` で機械可読出力にも対応しています。

## ブラウザ UI

```sh
kura browser        # http://127.0.0.1:7578 （127.0.0.1 のみバインド）
```

閲覧と編集は同じ画面です。レンダリングされた Markdown をその場で編集でき（Markdown ショートカット・選択ツールバー・自動保存）、バックリンクや 2 ホップリンクを脇に表示し、タグ・path の変更・削除はサイドバーで行います。ほかに 3 モード検索、ドキュメント path に沿ったサイドバーのツリー表示、タグブラウザ、d3-force によるナレッジグラフ（タグ色分け・陳腐化ノード減光）。

★を付けたドキュメントは、どの画面でもサイドバー上部に固定表示されます。その配下にあるドキュメントは折りたたみツリーとして展開できるので、よく戻ってくるノートに常に 1 クリックで辿り着けます。お気に入りは `kura export` / `kura import` でも往復します。

サイドバーで bucket を選ぶと、閲覧・検索・ツリー・グラフのすべてがその bucket 内に限定されます。選択は次回起動時も保持されます。

起動すると最後に読んでいたドキュメントに戻ります。ホームは表示履歴の一覧です。統計画面では、整理が必要な箇所（未整理・タグなし・孤立ドキュメント、未解決リンク、表記ゆれタグ）を数え、それぞれ対処に使う CLI コマンドを示します。

`Ctrl + P` で検索モーダルが開き、入力しながら結果が絞り込まれます。`Ctrl + N` で新しいドキュメントを作成し、`Ctrl + ?` でショートカット一覧を表示します。

## 設定

`~/.kura/config.toml`（`kura config list|get|set` で読み書き）:

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
path = "clips"        # 新しいクリップを保存するドキュメント path（"" で Bucket のルート）
```

環境変数: `KURA_HOME`（データディレクトリ、既定 `~/.kura`）、`KURA_DB`（DB パス上書き）、`NO_COLOR`

embedding モデルを変更したら `kura doctor --fix` → `kura embed` で再生成してください。

## 開発

```sh
bun install
bun run dev -- --help    # CLI 実行
bun test                 # テスト（KURA_TEST_DOWNLOAD=1 で vaporetto 実ダウンロード検証も実行）
bun run check            # 型チェック + Lint
bun run compile          # シングルバイナリ（現在のプラットフォーム向け）
```

アーキテクチャとサブシステムの詳細ドキュメントは [.claude/docs/](.claude/docs/README.md) にあります。コントリビューション規約（二言語ドキュメントポリシー含む）は [CLAUDE.md](CLAUDE.md) を参照してください。

## ライセンス

以下のいずれかを選択できます（デュアルライセンス）:

- Apache License, Version 2.0（[LICENSE-APACHE](LICENSE-APACHE)）
- MIT license（[LICENSE-MIT](LICENSE-MIT)）

明示的な表明がない限り、あなたがこの成果物への取り込みを意図して提出したコントリビューションは（Apache-2.0 ライセンスの定義に従い）、追加の条項なしに上記のデュアルライセンスが適用されます。
