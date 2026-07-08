// Embedded asset table, overwritten by scripts/compile.ts at compile time.
// During development (bun run) this stub stays as-is = nothing embedded; assets resolve from dist/ and node_modules.

/** SPA assets: URL path → path of the file embedded in the binary */
export const embeddedAssets: Record<string, string> = {};

/** Embedded path of the sqlite-vec extension (null = resolve from node_modules) */
export const embeddedVecLib: string | null = null;

/** Extraction file name (vec0.dylib / vec0.so / vec0.dll) */
export const embeddedVecLibName = "";
