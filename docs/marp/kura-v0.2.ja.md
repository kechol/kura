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

散らばった知識を、SQLite ひとつのファイルに。人にも、AI にも引けるように。

---

## AI 時代に、知識はどこへ行くのか

AI と対話するほど、調べたこと・決めたこと・試したことがたまって
いきます。でも、その大半はチャット履歴の奥に沈んだまま、次の
セッションには受け継がれません。

人が書くメモも同じです。増えるほどフォルダは深くなり、
「どこに置いたっけ」と探す時間ばかりが延びていきます。

<div class="flow-h">
  <div class="flow-step">知識が増える</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">どこかに仕舞う</div>
  <div class="flow-arrow">→</div>
  <div class="flow-step">見つからない</div>
</div>

<br>

**溜めるより、引き出すほうがずっと難しい。** 本当の課題は、そこにあります。

---

## そこで `kura` を作りました

`kura` は、Markdown や HTML のドキュメントを手元の SQLite ひとつに収め、
**人からも AI からも引き出せる**ようにする CLI です。

- **置き場所を強制しない** — Bucket・階層タグ・相互リンク（＋任意のパス）で整理
- **日本語に強いハイブリッド検索** — 形態素解析＋ベクトル＋リランク
- **まるごとローカル** — データは `~/.kura/kura.db` ただ 1 つ
- **AI エージェント連携** — MCP サーバーと、全コマンドの `--json` 出力

クラウドも、アカウントも、テレメトリーもいりません。

---

## 自己組織化: 仕舞わずに、つなぐ

フォルダは、置き場所を 1 つに決めろと迫ってきます。でも、メモが 2 つの
場所にまたがった瞬間、その決断は破綻します。だから kura は、**置き場所を
強制するフォルダ**をやめました。パスを添えることもできますが、フォルダと
違って必須ではありません。bucket 直下が、そのまま未整理の受け皿になります。

| 仕組み | 役割 |
| --- | --- |
| **Bucket** | フラットな最上位のグループ（`main` など） |
| **階層タグ** | `#tech/db/sqlite` は 3 階層すべてに同時に現れる |
| **相互リンク** | `[[タイトル]]`。**先に書けば、後から自動でつながる** |
| **ドキュメントパス** | `clips/技術` の任意の名前空間。フォルダではなく、強制もされない |

相互リンクは「先に書ける」のが強みです。まだ無いページへのリンクでも、
書いておけばそのページを作った瞬間につながります。バックリンクも、
2 ホップ先のつながりも、あとから勝手に見えてきます。

---

## 中核: 日本語のためのハイブリッド検索

この「引き出しにくさ」に、kura は検索で正面から応えます。
3 つのステージを、1 つの SQLite の中だけで回します。

<div class="pipe">
  <div class="pipe-row">
    <div class="pipe-badge pipe-kw">キーワード</div>
    <div class="pipe-desc">FTS5 ＋ <strong>sqlite-vaporetto</strong> の形態素解析。日本語を単語の単位で切って探す（trigram フォールバックあり）</div>
  </div>
  <div class="pipe-row">
    <div class="pipe-badge pipe-vec">セマンティック</div>
    <div class="pipe-desc"><strong>sqlite-vec</strong> のベクトル KNN。ローカル embedding で、語ではなく意味で手繰る</div>
  </div>
  <div class="pipe-row">
    <div class="pipe-badge pipe-rank">リランク</div>
    <div class="pipe-desc">両者を束ね、ローカル LLM で並べ替え。いちばん効く順に返す</div>
  </div>
</div>

<br>

検索は、`kura search`（キーワード）/ `kura vsearch`（セマンティック）/
`kura query`（ハイブリッド）の 3 つを使い分けるだけです。

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

# 移動・整理（[[リンク]] も貼り替わる）
kura mv "今日のメモ" --path db/sqlite     # パス名前空間へ移動
kura mv suggest                          # 未整理ドキュメントに置き場所を提案
```

コミットは待ちません。書いたそばから、インデックスに乗ります。
読み取り系のコマンドは、どれも `--json` を返せます。

---

## ブラウザでも、読んで・書いて・整える

`kura browser` でローカルサーバを起動。同じコアを、今度はブラウザから。

- **バケットでスコープ** — サイドバーで選んだ 1 つに、一覧も検索もツリーも揃う
- **その場で編集** — 読んでいる画面のまま手を入れられる。Markdown ショートカットと自動保存
- **お気に入り** — ★ を付けたドキュメントをサイドバーに固定
- **検索モーダル** — `Ctrl + P` で打ちながら絞り込み。キーボードだけで動く
- **統計と気づき** — 未整理・未タグ・孤立・壊れたリンクを、直すコマンドつきで教えてくれる

ドキュメントツリー・タグツリー・バックリンク・知識グラフも、そのまま。

---

## AI エージェントの「長期記憶」になる

kura は MCP サーバーにもなります。検索も読み書きも、エージェントの道具
として差し出す。エージェントはいつものツール操作のまま、過去の知識を
思い出し、気づいたことを書き足していけます。

```sh
claude mcp add kura -- kura mcp     # Claude Code に接続
```

公開ツール: `kura_query`（ハイブリッド検索）, `kura_search`,
`kura_get`, `kura_add`, `kura_update`, `kura_list_tags`,
`kura_related`, `kura_status`

セッションをまたいで積み上がっていく記憶。それが、kura のもう 1 つの顔です。

---

## ローカル LLM で、もっと強力に

キーワード検索・CRUD・リンク・タグは、**モデルなしでいつでも動きます**。

<div class="flow-h">
  <div class="flow-step">キーワード検索</div>
  <div class="flow-step">CRUD</div>
  <div class="flow-step">リンク</div>
  <div class="flow-step">タグ</div>
</div>

<br>

ここに Ollama や LM Studio をつなぐと、kura はさらに賢くなります。

- **セマンティック検索** — 語ではなく意味で手繰る（ローカル embedding）
- **ハイブリッドのリランク** — いちばん効く順に並べ替え
- **clip 整形** — Web ページを読みやすい Markdown に
- **タグ提案 / クエリ展開** — 既存タグ優先の付与と、検索語の言い換え・拡張
- **mv suggest** — 未整理ドキュメントに、理由つきで置き場所を提案

プロバイダは自動検出。無ければそっと警告して代替へ切り替わるので、
飛行機の中でも止まりません。

---

## 内部アーキテクチャ

中身は、SQLite ファイル 1 つにすべて収まります。SQL トリガーは使いません。
派生テーブルの整合は、リポジトリ層が 1 トランザクションでまとめて取ります。

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

配布は、`bun build --compile` で作るプラットフォームごとの単一バイナリ。
SPA アセットも sqlite-vec 拡張も、その中に埋め込み済みです。

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
| **ドキュメント** | `kura add` / `kura get` / `kura edit` / `kura rm` / `kura mv` / `kura ls` / `kura clip` |
| **検索** | `kura search` / `kura vsearch` / `kura query` / `kura embed` |
| **整理** | `kura bucket` / `kura tag` / `kura link` |
| **入出力** | `kura export` / `kura import` |
| **サーバー** | `kura browser` / `kura mcp` |

<br>

**前提（macOS）:** `brew install sqlite`（拡張のロードに Homebrew 版の
SQLite が要ります）。**LLM（任意）:** Ollama / LM Studio。
