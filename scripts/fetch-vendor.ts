#!/usr/bin/env bun
/**
 * Fetch sqlite-vec prebuilts for cross-compilation from the npm registry into vendor/.
 * bun install only unpacks the optional dependency for the running platform, so
 * release builds (5 targets) prefetch the prebuilts for every platform.
 *
 * Usage: bun run scripts/fetch-vendor.ts [target...]
 *   All targets when omitted. Example: bun-darwin-arm64 bun-linux-x64
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import pkg from "../package.json" with { type: "json" };

export const VEC_VERSION = pkg.dependencies["sqlite-vec"];
if (!/^\d+\.\d+\.\d+$/.test(VEC_VERSION)) {
  throw new Error("package.json must pin sqlite-vec to an exact stable version");
}

interface VendorTarget {
  /** --target name for bun build --compile */
  bunTarget: string;
  npmPackage: string;
  lib: string;
  integrity: string;
}

export const VENDOR_TARGETS: VendorTarget[] = [
  {
    bunTarget: "bun-darwin-arm64",
    npmPackage: "sqlite-vec-darwin-arm64",
    lib: "vec0.dylib",
    integrity:
      "sha512-jSsZpE42OfBkGL/ItyJTVCUwl6o6Ka3U5rc4j+UBDIQzC1ulSSKMEhQLthsOnF/MdAf1MuAkYhkdKmmcjaIZQg==",
  },
  {
    bunTarget: "bun-darwin-x64",
    npmPackage: "sqlite-vec-darwin-x64",
    lib: "vec0.dylib",
    integrity:
      "sha512-KDlVyqQT7pnOhU1ymB9gs7dMbSoVmKHitT+k1/xkjarcX8bBqPxWrGlK/R+C5WmWkfvWwyq5FfXfiBYCBs6PlA==",
  },
  {
    bunTarget: "bun-linux-x64",
    npmPackage: "sqlite-vec-linux-x64",
    lib: "vec0.so",
    integrity:
      "sha512-w3tCH8xK2finW8fQJ/m8uqKodXUZ9KAuAar2UIhz4BHILfpE0WM/MTGCRfa7RjYbrYim5Luk3guvMOGI7T7JQA==",
  },
  {
    bunTarget: "bun-linux-arm64",
    npmPackage: "sqlite-vec-linux-arm64",
    lib: "vec0.so",
    integrity:
      "sha512-5wXVJ9c9kR4CHm/wVqXb/R+XUHTdpZ4nWbPHlS+gc9qQFVHs92Km4bPnCKX4rtcPMzvNis+SIzMJR1SCEwpuUw==",
  },
  {
    bunTarget: "bun-windows-x64",
    npmPackage: "sqlite-vec-windows-x64",
    lib: "vec0.dll",
    integrity:
      "sha512-y3gEIyy/17bq2QFPQOWLE68TYWcRZkBQVA2XLrTPHNTOp55xJi/BBBmOm40tVMDMjtP+Elpk6UBUXdaq+46b0Q==",
  },
];

const root = join(import.meta.dir, "..");

export function vendorLibPath(bunTarget: string): string {
  const target = VENDOR_TARGETS.find((t) => t.bunTarget === bunTarget);
  if (!target) throw new Error(`unknown target: ${bunTarget}`);
  return join(root, "vendor", "sqlite-vec", VEC_VERSION, bunTarget, target.lib);
}

interface VendorMetadata {
  package: string;
  version: string;
  integrity: string;
  librarySha256: string;
}

function hash(
  data: ArrayBuffer | Uint8Array,
  algorithm: "sha256" | "sha512",
  encoding: "hex" | "base64",
): string {
  const hasher = new Bun.CryptoHasher(algorithm);
  hasher.update(data);
  return hasher.digest(encoding);
}

export function verifyTarballIntegrity(data: ArrayBuffer | Uint8Array, expected: string): void {
  const [algorithm, digest] = expected.split("-", 2);
  if (algorithm !== "sha512" || !digest) throw new Error(`unsupported integrity: ${expected}`);
  const actual = hash(data, "sha512", "base64");
  if (actual !== digest) {
    throw new Error(`integrity mismatch: expected ${expected}, got sha512-${actual}`);
  }
}

function cacheMetadataPath(dest: string): string {
  return `${dest}.metadata.json`;
}

function validCache(target: VendorTarget, dest: string): boolean {
  const metadataPath = cacheMetadataPath(dest);
  if (!existsSync(dest) || !existsSync(metadataPath)) return false;
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as VendorMetadata;
    return (
      metadata.package === target.npmPackage &&
      metadata.version === VEC_VERSION &&
      metadata.integrity === target.integrity &&
      metadata.librarySha256 === hash(readFileSync(dest), "sha256", "hex")
    );
  } catch {
    return false;
  }
}

async function fetchTarget(target: VendorTarget): Promise<void> {
  const dest = vendorLibPath(target.bunTarget);
  if (validCache(target, dest)) {
    console.error(`vendor: ${target.bunTarget} verified (${dest})`);
    return;
  }
  rmSync(dest, { force: true });
  rmSync(cacheMetadataPath(dest), { force: true });
  const url = `https://registry.npmjs.org/${target.npmPackage}/-/${target.npmPackage}-${VEC_VERSION}.tgz`;
  console.error(`vendor: downloading ${url}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);

  const dir = join(root, "vendor", "sqlite-vec", VEC_VERSION, target.bunTarget);
  mkdirSync(dir, { recursive: true });
  const workDir = join(dir, `.tmp-${process.pid}-${crypto.randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
  try {
    const data = await res.arrayBuffer();
    verifyTarballIntegrity(data, target.integrity);
    const tgz = join(workDir, "package.tgz");
    await Bun.write(tgz, data);
    const proc = Bun.spawnSync([
      "tar",
      "-xzf",
      tgz,
      "-C",
      workDir,
      "--strip-components=1",
      `package/${target.lib}`,
    ]);
    if (proc.exitCode !== 0) {
      throw new Error(`extract failed: ${proc.stderr.toString()}`);
    }
    const extracted = join(workDir, target.lib);
    if (!existsSync(extracted)) throw new Error(`library not found after extract: ${extracted}`);
    mkdirSync(dirname(dest), { recursive: true });
    renameSync(extracted, dest);
    const metadata: VendorMetadata = {
      package: target.npmPackage,
      version: VEC_VERSION,
      integrity: target.integrity,
      librarySha256: hash(readFileSync(dest), "sha256", "hex"),
    };
    const metadataTemp = join(workDir, "metadata.json");
    writeFileSync(metadataTemp, `${JSON.stringify(metadata)}\n`);
    renameSync(metadataTemp, cacheMetadataPath(dest));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
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
