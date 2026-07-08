---
marp: true
theme: default
paginate: true
size: 16:9
header: 'kura — Local knowledge, hybrid search, for humans and agents'
style: |
  section {
    font-family: 'Helvetica Neue', 'Hiragino Sans', sans-serif;
    padding: 60px 80px;
  }
  section.lead {
    text-align: center;
    justify-content: center;
  }
  h1 {
    color: #275c86;
  }
  h2 {
    color: #275c86;
    border-bottom: 2px solid #275c86;
    padding-bottom: 8px;
  }
  strong {
    color: #275c86;
  }
  code {
    background: #e8f1f8;
    color: #1d465f;
    padding: 2px 6px;
    border-radius: 4px;
  }
  pre {
    background: #0f172a;
    color: #e2e8f0;
    border-radius: 6px;
    padding: 16px;
    font-size: 0.75em;
  }
  pre code {
    background: transparent;
    color: inherit;
  }
  header {
    color: #94a3b8;
    font-size: 0.7em;
  }
  .install-hero {
    font-family: 'SF Mono', 'Menlo', 'Consolas', monospace;
    font-size: 1.6em;
    font-weight: bold;
    color: #275c86;
    text-align: center;
    padding: 32px 24px;
    margin: 24px 0;
    letter-spacing: 0.02em;
  }
  .cta-heading {
    font-size: 1.1em;
    color: #475569;
    text-align: center;
    margin: 0 0 16px;
    font-weight: normal;
  }
  .links {
    font-size: 1.1em;
    line-height: 2.2;
    text-align: center;
  }
  .icon-inline {
    width: 24px;
    height: 24px;
    vertical-align: -6px;
    margin-right: 8px;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    font-size: 0.8em;
    margin-top: 12px;
  }
  th, td {
    border: 1px solid #cbd5e1;
    padding: 8px 12px;
    text-align: left;
    vertical-align: top;
  }
  th {
    background: #275c86;
    color: white;
  }
  tbody tr:nth-child(even) {
    background: #e8f1f8;
  }
  td code {
    font-size: 0.92em;
  }
  .flow-h {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin-top: 28px;
    flex-wrap: wrap;
  }
  .flow-step {
    padding: 10px 16px;
    border-radius: 8px;
    background: #e8f1f8;
    color: #1d465f;
    border: 1px solid #b9d5e8;
    text-align: center;
    font-weight: 600;
    font-size: 0.9em;
    white-space: nowrap;
  }
  .flow-arrow {
    font-size: 1.3em;
    color: #94a3b8;
    line-height: 1;
  }
  .pipe {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 16px;
  }
  .pipe-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .pipe-badge {
    flex: 0 0 150px;
    padding: 8px 12px;
    border-radius: 6px;
    color: white;
    font-weight: bold;
    font-size: 0.82em;
    text-align: center;
  }
  .pipe-kw   { background: #5fa9d6; }
  .pipe-vec  { background: #275c86; }
  .pipe-rank { background: #163a52; }
  .pipe-desc {
    font-size: 0.85em;
    color: #334155;
  }
  .arch-stack {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-top: 12px;
  }
  .arch-layer {
    background: #f8fafc;
    border-left: 4px solid #275c86;
    border-radius: 6px;
    padding: 10px 16px;
    font-size: 0.88em;
    line-height: 1.4;
  }
  .arch-layer-title {
    font-weight: bold;
    color: #275c86;
  }
  .arch-layer-detail {
    color: #475569;
  }
  .arch-arrow-up {
    text-align: center;
    font-size: 0.9em;
    color: #94a3b8;
    line-height: 1;
    margin: 0;
  }
---

<!-- _class: lead -->
<!-- _paginate: false -->
<!-- _header: '' -->

# ローカルで完結する<br>ナレッジ管理 CLI `kura`

<br>

### Local knowledge, hybrid search, for humans and agents

<br>

散らばる知識を、SQLite 1 ファイルに。人にも、AI にも引ける形で。

---

## AI 時代に、知識はどこへ行くのか

AI エージェントとの対話は、調査結果・設計判断・試行錯誤を大量に生み
出します。けれど、その多くはチャット履歴の底に沈み、次のセッションには
引き継がれません。

一方、人の側のメモも増え続けます。フォルダに仕舞おうとするほど、
「どこに置いたか」で迷うようになります。

<div class="flow-h">
  <div class="flow-step">知識が増える</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">どこかに仕舞う</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">見つからない</div>
</div>

<br>

**溜めることより、引き出せることが難しい。** ここが本当の課題です。

---

## そこで `kura` を作りました

`kura` は、Markdown / HTML ドキュメントを単一のローカル SQLite ファイル
に格納し、**人間と AI エージェントの双方から引ける**ようにする CLI です。

- **フォルダ階層なし** — Bucket + 階層タグ + 相互リンク（Cosense 方式）
- **日本語対応ハイブリッド検索** — 形態素解析 + ベクトル + リランク
- **ローカル完結** — データは `~/.kura/kura.db` の 1 ファイルだけ
- **AI エージェント連携** — MCP サーバーと全コマンドの `--json` 出力

クラウドも、アカウントも、テレメトリーもありません。

---

## 自己組織化: 仕舞わずに、つなぐ

フォルダは、ドキュメントごとに「1 つの置き場所」を強います。その判断は、
メモが 2 か所に属した瞬間に間違いになります。kura は階層を捨てました。

| 仕組み | 役割 |
| --- | --- |
| **Bucket** | フラットな最上位のグループ（`main` など） |
| **階層タグ** | `#tech/db/sqlite` は 3 階層すべてに同時に現れる |
| **相互リンク** | `[[タイトル]]`。**先に書けば、後から自動でつながる** |

相互リンクの「先に書ける」点が効きます。まだ存在しないページへの参照を
書いておくと、そのページが作られた瞬間に接続され、バックリンクや
2 ホップリンクも自然に導かれます。

---

## 中核: 日本語のためのハイブリッド検索

溜めるより引き出す方が難しい——だから kura は検索に力を入れています。
3 つのステージを 1 つの SQLite の中で回します。

<div class="pipe">
  <div class="pipe-row">
    <div class="pipe-badge pipe-kw">キーワード</div>
    <div class="pipe-desc">FTS5 + <strong>sqlite-vaporetto</strong> 形態素解析。日本語を単語境界で分割（trigram フォールバックあり）</div>
  </div>
  <div class="pipe-row">
    <div class="pipe-badge pipe-vec">セマンティック</div>
    <div class="pipe-desc"><strong>sqlite-vec</strong> によるベクトル KNN。ローカル embedding で「意味」で一致</div>
  </div>
  <div class="pipe-row">
    <div class="pipe-badge pipe-rank">リランク</div>
    <div class="pipe-desc">両者を融合し、ローカル LLM で並べ替え。最高精度</div>
  </div>
</div>

<br>

`kura search`（キーワード）/ `kura vsearch`（セマンティック）/
`kura query`（ハイブリッド）の 3 コマンドで使い分けます。

---

## CLI: 溜めて、引く

```sh
# 追加
kura add notes/sqlite-wal.md --tags tech/db/sqlite
echo "# 今日のメモ" | kura add - --title "今日のメモ"
kura clip https://example.com/article    # Web ページを LLM で整形して取り込み

# 検索（3 モード）
kura search  "WAL チェックポイント"       # キーワード（< 100ms）
kura vsearch "書き込み中も読める仕組み"    # セマンティック
kura query   "SQLite の並行性"            # ハイブリッド + リランク

# つながりを辿る
kura link ls "今日のメモ"                 # アウトリンク / バックリンク / 2 ホップ
```

コミット単位ではなく、書いたそばからインデックスが更新されます。
すべての読み取りコマンドは `--json` にも対応します。

---

## AI エージェントの「長期記憶」になる

kura は MCP サーバーとして、検索と CRUD をエージェントのツールとして
公開します。エージェントは通常のツール利用の中で、過去の知識を思い出し、
新しい発見を書き戻せます。

```sh
claude mcp add kura -- kura mcp     # Claude Code に接続
```

公開ツール: `kura_query`（ハイブリッド検索）, `kura_search`,
`kura_get`, `kura_add`, `kura_update`, `kura_list_tags`,
`kura_related`, `kura_status`

セッションをまたいで積み上がる記憶——それが kura のもう 1 つの顔です。

---

## 優雅な劣化: モデルは必須ではない

kura は、LLM プロバイダに到達できなくても壊れません。

<div class="flow-h">
  <div class="flow-step">キーワード検索</div>
  <div class="flow-step">CRUD</div>
  <div class="flow-step">リンク</div>
  <div class="flow-step">タグ</div>
</div>

<br>

これらは**モデルなしで常に動きます**。セマンティック検索・リランク・
clip 整形・タグ提案・クエリ展開は、プロバイダが無ければ警告を出して
フォールバックします。

飛行機の中でも使えます。失われるのは、本当にモデルを必要とする機能
だけです。Ollama / LM Studio は自動検出されます。

---

## 内部アーキテクチャ

すべては単一の SQLite ファイルの中に収まります。SQL トリガーは使わず、
リポジトリ層が派生テーブルを 1 トランザクションで整合させます。

<div class="arch-stack">
  <div class="arch-layer">
    <span class="arch-layer-title">CLI / Browser / MCP</span> <span class="arch-layer-detail">— 3 つのフロントエンド。同じコアを再利用</span>
  </div>
  <div class="arch-arrow-up">↓</div>
  <div class="arch-layer">
    <span class="arch-layer-title">core</span> <span class="arch-layer-detail">— ドキュメント・検索・リンク・タグのドメインロジック</span>
  </div>
  <div class="arch-arrow-up">↓</div>
  <div class="arch-layer">
    <span class="arch-layer-title">SQLite + 拡張</span> <span class="arch-layer-detail">— FTS5 / sqlite-vec / sqlite-vaporetto</span>
  </div>
</div>

<br>

配布は `bun build --compile` によるプラットフォーム別の単一バイナリ。
SPA アセットと sqlite-vec 拡張はバイナリに埋め込み済みです。

---

<!-- _class: lead -->

<p class="cta-heading">ぜひ使ってみてください</p>

<div class="install-hero">brew install kechol/tap/kura</div>

<div class="links">

<img class="icon-inline" src="https://cdn.jsdelivr.net/gh/devicons/devicon@latest/icons/github/github-original.svg" alt="GitHub" /> https://github.com/kechol/kura
📖 https://kechol.github.io/kura/ja/

</div>

---

## Appendix: コマンド早見表

| 分類 | コマンド |
| --- | --- |
| **セットアップ** | `kura init` / `kura doctor` / `kura status` / `kura config` |
| **ドキュメント** | `kura add` / `kura get` / `kura edit` / `kura ls` / `kura clip` |
| **検索** | `kura search` / `kura vsearch` / `kura query` / `kura embed` |
| **整理** | `kura bucket` / `kura tag` / `kura link` |
| **入出力** | `kura export` / `kura import` |
| **サーバー** | `kura browser` / `kura mcp` |

<br>

**前提（macOS）:** `brew install sqlite`（拡張ロードに Homebrew の
SQLite が必要）。**LLM（任意）:** Ollama / LM Studio。
