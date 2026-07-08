#!/usr/bin/env bun
/**
 * クロスコンパイル用の sqlite-vec プリビルドを npm レジストリから vendor/ へ取得する。
 * bun install は実行プラットフォームの optional dependency しか展開しないため、
 * リリースビルド（5 ターゲット）では全プラットフォーム分を事前取得する。
 *
 * 使い方: bun run scripts/fetch-vendor.ts [target...]
 *   target 省略時は全ターゲット。例: bun-darwin-arm64 bun-linux-x64
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const VEC_VERSION = "0.1.9";

interface VendorTarget {
  /** bun build --compile の --target 名 */
  bunTarget: string;
  npmPackage: string;
  lib: string;
}

export const VENDOR_TARGETS: VendorTarget[] = [
  { bunTarget: "bun-darwin-arm64", npmPackage: "sqlite-vec-darwin-arm64", lib: "vec0.dylib" },
  { bunTarget: "bun-darwin-x64", npmPackage: "sqlite-vec-darwin-x64", lib: "vec0.dylib" },
  { bunTarget: "bun-linux-x64", npmPackage: "sqlite-vec-linux-x64", lib: "vec0.so" },
  { bunTarget: "bun-linux-arm64", npmPackage: "sqlite-vec-linux-arm64", lib: "vec0.so" },
  { bunTarget: "bun-windows-x64", npmPackage: "sqlite-vec-windows-x64", lib: "vec0.dll" },
];

const root = join(import.meta.dir, "..");

export function vendorLibPath(bunTarget: string): string {
  const target = VENDOR_TARGETS.find((t) => t.bunTarget === bunTarget);
  if (!target) throw new Error(`unknown target: ${bunTarget}`);
  return join(root, "vendor", "sqlite-vec", bunTarget, target.lib);
}

async function fetchTarget(target: VendorTarget): Promise<void> {
  const dest = vendorLibPath(target.bunTarget);
  if (existsSync(dest)) {
    console.error(`vendor: ${target.bunTarget} は取得済み (${dest})`);
    return;
  }
  const url = `https://registry.npmjs.org/${target.npmPackage}/-/${target.npmPackage}-${VEC_VERSION}.tgz`;
  console.error(`vendor: downloading ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);

  const dir = join(root, "vendor", "sqlite-vec", target.bunTarget);
  mkdirSync(dir, { recursive: true });
  const tgz = join(dir, "package.tgz");
  await Bun.write(tgz, res);
  // npm tarball は package/ プレフィックス。ライブラリだけ展開する
  const proc = Bun.spawnSync([
    "tar",
    "-xzf",
    tgz,
    "-C",
    dir,
    "--strip-components=1",
    `package/${target.lib}`,
  ]);
  if (proc.exitCode !== 0) {
    throw new Error(`extract failed: ${proc.stderr.toString()}`);
  }
  Bun.spawnSync(["rm", "-f", tgz]);
  if (!existsSync(dest)) throw new Error(`library not found after extract: ${dest}`);
  console.error(`vendor: ${target.bunTarget} -> ${dest}`);
}

if (import.meta.main) {
  const requested = process.argv.slice(2);
  const targets =
    requested.length > 0
      ? VENDOR_TARGETS.filter((t) => requested.includes(t.bunTarget))
      : VENDOR_TARGETS;
  if (requested.length > 0 && targets.length !== requested.length) {
    const known = new Set(VENDOR_TARGETS.map((t) => t.bunTarget));
    const unknown = requested.filter((r) => !known.has(r));
    throw new Error(`unknown targets: ${unknown.join(", ")}`);
  }
  for (const target of targets) {
    await fetchTarget(target);
  }
}
