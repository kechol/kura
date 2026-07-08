#!/usr/bin/env bun
/**
 * Build release archives + a SHA256SUMS manifest (docs: build-and-release.md).
 *
 * Consumes the per-target binaries that scripts/compile.ts placed under
 * release/<bun-target>/kura[.exe] and produces, at release/:
 *   - kura-<platform>.tar.gz   (macOS / Linux; binary at the archive root)
 *   - kura-<platform>.zip      (Windows)
 *   - SHA256SUMS.txt           (one `<sha256>  <file>` line per archive)
 *
 * <platform> is the bun target minus the `bun-` prefix (e.g. darwin-arm64).
 * The tag is NOT in the archive name — the release download path carries the
 * version, which keeps the generated Homebrew formula (scripts/gen-formula.ts)
 * simple. Each archive bundles the matching installer plus the licenses and
 * README so a direct-download user has everything; the Homebrew formula
 * installs only the binary and drops the rest.
 *
 * Usage: bun run scripts/package-release.ts
 *   (Compile each target to release/<bun-target>/kura[.exe] beforehand.)
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const releaseDir = join(root, "release");

const targets = readdirSync(releaseDir).filter((d) => d.startsWith("bun-"));
if (targets.length === 0) throw new Error(`no compiled targets under ${releaseDir}`);

// Files shipped alongside the binary in every archive.
const EXTRA_FILES = ["LICENSE-MIT", "LICENSE-APACHE", "README.md"];

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(cmd: string[], cwd: string): void {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`command failed: ${cmd.join(" ")}`);
}

const sums: string[] = [];

for (const target of targets) {
  const platform = target.replace(/^bun-/, "");
  const isWindows = platform.startsWith("windows");
  const binName = isWindows ? "kura.exe" : "kura";
  const binary = join(releaseDir, target, binName);
  if (!existsSync(binary)) throw new Error(`binary not found: ${binary}`);

  // Stage the archive contents in a flat temp dir (binary at the root so the
  // Homebrew formula's `bin.install "kura"` finds it).
  const stage = mkdtempSync(join(tmpdir(), `kura-${platform}-`));
  copyFileSync(binary, join(stage, binName));
  const installer = isWindows ? "install.ps1" : "install.sh";
  copyFileSync(join(root, "scripts", installer), join(stage, installer));
  for (const f of EXTRA_FILES) {
    const src = join(root, f);
    if (existsSync(src)) copyFileSync(src, join(stage, f));
  }

  const archive = isWindows ? `kura-${platform}.zip` : `kura-${platform}.tar.gz`;
  const archivePath = join(releaseDir, archive);
  if (isWindows) {
    // -j: junk paths, so entries sit at the archive root.
    run(["zip", "-j", archivePath, ...readdirSync(stage).map((f) => join(stage, f))], stage);
  } else {
    run(["tar", "-czf", archivePath, "-C", stage, "."], stage);
  }

  sums.push(`${sha256(archivePath)}  ${archive}`);
  console.error(`packaged: release/${archive}`);
}

sums.sort();
await Bun.write(join(releaseDir, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
console.error("wrote: release/SHA256SUMS.txt");
