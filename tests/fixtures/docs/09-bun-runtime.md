---
title: "Bunランタイム移行メモ"
tags: ["tech/typescript/bun"]
bucket: main
---

## 移行の動機

Node.js から Bun へ移行した。起動が速く、TypeScript をトランスパイルなしで直接実行できるのが決め手。テストランナーも組み込みで、ツールチェーンが大幅に単純化された。

## 移行時の作業

- package.json のスクリプトを bun 前提に書き換える
- fs/promises などの Node API はそのまま動くものが多い
- bun:sqlite への置き換えで better-sqlite3 を依存から外せた

## 引っかかった点

スキーマ管理に使っていたマイグレーションのスクリプトは bun:sqlite でもそのまま動いた。一方で、一部の npm パッケージはネイティブ拡張のビルドで失敗するため、代替の純 JS 実装へ差し替えた。互換性の落とし穴は見つけ次第ここへ追記する。
