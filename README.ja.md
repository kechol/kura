# kura

[English README is here](README.md)

Markdown/HTML ドキュメントを SQLite に格納し、人間と AI エージェントの双方がクエリーできるローカルナレッジ管理 CLI。

- **日本語対応ハイブリッド検索**: FTS5 + [sqlite-vaporetto](https://github.com/hotchpotch/sqlite-vaporetto)（形態素解析）によるキーワード検索、[sqlite-vec](https://github.com/asg017/sqlite-vec) + ローカル embedding によるセマンティック検索、ローカル LLM によるリランク
- **自己組織化**: 階層フォルダなし。Bucket + 階層タグ（`tech/db/sqlite`）+ 相互リンク（`[[タイトル]]`）で整理（Cosense 方式）
- **AI エージェント連携**: `kura mcp`（MCP サーバー）と全コマンドの `--json` 出力
- **ブラウザ UI**: ドキュメント閲覧・編集・ナレッジグラフ可視化（`kura browser`）
- **ローカル完結**: データは `~/.kura/kura.db` の単一 SQLite。LLM は Ollama / LM Studio を自動検出（無くてもキーワード検索は動作）

## インストール

### 前提条件

- **macOS**: Homebrew の SQLite が必要（Apple 純正 SQLite は拡張ロード不可のため）

  ```sh
  brew install sqlite
  ```

- **LLM 機能（任意）**: [Ollama](https://ollama.com/) または LM Studio。無い場合はキーワード検索のみの劣化動作

### バイナリ

[Releases](../../releases) から対象プラットフォームの ZIP をダウンロードして展開:

```sh
unzip kura-*.zip && ./install.sh   # macOS では quarantine 属性も除去される
```

### 初期化

```sh
kura init      # ~/.kura の作成、拡張のダウンロード、DB 作成
kura doctor    # 環境診断（SQLite / 拡張 / LLM プロバイダ / DB 整合性）
```

`kura init` は日本語形態素解析トークナイザー（sqlite-vaporetto、モデル同梱 約 6.5MB）を GitHub Releases から SHA256 検証付きでダウンロードします。未対応環境（darwin-x64 等）では自動的に trigram トークナイザーへフォールバックします。

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
kura clip https://example.com/article        # Web ページを整形して取り込み

# 検索（3 モード）
kura search "WAL チェックポイント"           # キーワード（FTS5 BM25、< 100ms）
kura vsearch "書き込み中も読める仕組み"      # セマンティック（KNN）
kura query "SQLite の並行性"                 # ハイブリッド + リランク（最高精度）

# 閲覧・編集
kura get "今日のメモ"          # doc_key / #key / タイトルで指定
kura edit "今日のメモ"         # $EDITOR で編集（frontmatter でタグ・タイトルも変更可）
kura ls --tag tech/db --sort updated

# リンクとタグ
kura link ls "今日のメモ"      # アウトリンク / バックリンク / 2ホップ
kura link broken               # 未解決リンク一覧
kura tag ls --tree
kura tag suggest --untagged --apply   # LLM がタグ提案（既存タグ体系を優先）
kura tag audit                 # 類似タグの統合提案・巨大タグの検出

# メンテナンス
kura status                    # 統計（embedding カバレッジ・陳腐化候補など）
kura ls --stale                # 長期未更新 & 低参照のドキュメント
kura doctor --fix              # インデックス修復・未解決リンク再解決など
kura export --dir backup/      # frontmatter 付き Markdown で書き出し
kura import backup/            # kura_key でラウンドトリップ（更新 or 新規）
```

本文中の記法:

- `[[タイトル]]` / `[[タイトル|表示名]]` — 相互リンク。**先にリンクを書いておけば、後からページを作ったときに自動で繋がります**
- `#tech/db/sqlite` — 階層タグ（保存時に自動抽出）

## AI エージェント連携（MCP）

```sh
claude mcp add kura -- kura mcp     # Claude Code
kura mcp --print-config             # .mcp.json 用スニペット
```

公開ツール: `kura_query`（ハイブリッド検索）, `kura_search`, `kura_get`, `kura_add`, `kura_update`, `kura_list_tags`, `kura_related`, `kura_status`

すべての読み取りコマンドは `--json` で機械可読出力にも対応しています。

## ブラウザ UI

```sh
kura browser        # http://127.0.0.1:7578 （127.0.0.1 のみバインド）
```

ドキュメント閲覧（Markdown レンダリング・バックリンク・2ホップリンク）、編集、3 モード検索、タグブラウザ、d3-force によるナレッジグラフ（タグ色分け・陳腐化ノード減光）。

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

アーキテクチャとサブシステムの詳細ドキュメントは [.claude/docs/](.claude/docs/README.md) にあります（[SPEC.md](SPEC.md) は設計ベースラインの索引）。コントリビューション規約（二言語ドキュメントポリシー含む）は [CLAUDE.md](CLAUDE.md) を参照してください。

## ライセンス

以下のいずれかを選択できます（デュアルライセンス）:

- Apache License, Version 2.0（[LICENSE-APACHE](LICENSE-APACHE)）
- MIT license（[LICENSE-MIT](LICENSE-MIT)）

明示的な表明がない限り、あなたがこの成果物への取り込みを意図して提出したコントリビューションは（Apache-2.0 ライセンスの定義に従い）、追加の条項なしに上記のデュアルライセンスが適用されます。
