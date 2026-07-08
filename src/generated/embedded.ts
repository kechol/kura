// scripts/compile.ts がコンパイル時に上書きする埋め込みアセット表。
// 開発時（bun run）はこのスタブのまま = 埋め込みなしで、dist/ と node_modules から解決する。

/** SPA アセット: URL パス → バイナリ埋め込みファイルのパス */
export const embeddedAssets: Record<string, string> = {};

/** sqlite-vec 拡張の埋め込みパス（null なら node_modules から解決） */
export const embeddedVecLib: string | null = null;

/** 展開先ファイル名（vec0.dylib / vec0.so / vec0.dll） */
export const embeddedVecLibName = "";
