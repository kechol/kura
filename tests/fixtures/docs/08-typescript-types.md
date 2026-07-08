---
title: "TypeScriptの型パズル入門"
tags: ["tech/typescript"]
bucket: main
---

## Conditional Types

型レベルの条件分岐は extends で書く。

```ts
type ElementType<T> = T extends (infer U)[] ? U : never;
```

infer を使うと型の一部を取り出せる。配列やタプル、関数の引数など、構造を分解したいときの基本道具になる。

## Mapped Types

- keyof でプロパティ名の集合を取り出す
- in で各プロパティを走査して変換する
- as 句を使えばキーのリネームもできる

## 所感

型パズルは楽しいが、読み手の負担が大きい。実務ではユーティリティ型の入れ子を 2 段までに抑えるルールにしている。深い再帰型はコンパイル時間にも響くので、複雑さに見合う価値があるかを常に問うべき。
