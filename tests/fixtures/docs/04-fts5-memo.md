---
title: "FTS5の使い方メモ"
tags: ["tech/db/sqlite", "tech/search"]
bucket: main
---

## 仮想テーブルの作成

```sql
CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, tokenize='trigram');
```

外部コンテンツテーブル方式にすると本文の二重保持を避けられるが、同期の責任はアプリ側に移る。

## クエリの書き方

- MATCH 句にはフレーズを二重引用符で囲んで渡す
- bm25() は小さいほど良いスコアなので並び順に注意
- snippet() でハイライト付きの抜粋を生成できる

## 補足

全文検索の候補エンジンは [[全文検索エンジンの比較]] を参照。トークナイザーを trigram にすると 3 文字未満の語を拾えない点は、短い語だけ LIKE で補うなど運用側の工夫が要る。
