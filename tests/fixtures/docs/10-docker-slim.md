---
title: "Dockerイメージ軽量化"
tags: ["tech/docker"]
bucket: main
---

## マルチステージビルド

ビルド用と実行用のステージを分けるのが基本。実行ステージには成果物だけをコピーする。

```dockerfile
FROM oven/bun:1 AS build
COPY . .
RUN bun build ./src/index.ts --compile --outfile app

FROM gcr.io/distroless/base
COPY --from=build /app/app /app
```

## 削減チェックリスト

- ベースイメージを distroless か alpine にする
- ビルド専用の依存を実行イメージへ持ち込まない
- .dockerignore で node_modules やキャッシュを除外する

## 結果

計測したところ、1.2GB あったイメージが 98MB まで縮んだ。デプロイ時間の短縮だけでなく、脆弱性スキャンの対象面積が減る効果も大きい。
