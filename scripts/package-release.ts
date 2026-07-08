#!/usr/bin/env bun
/**
 * Build release ZIPs. Bundles the binaries that scripts/compile.ts placed under
 * release/<target>/ together with install.sh / install.ps1.
 *
 * Usage: bun run scripts/package-release.ts <tag>
 *   (Compile each target to release/<bun-target>/kura[.exe] beforehand)
 */
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const releaseDir = join(root, "release");

const tag = process.argv[2];
if (!tag) throw new Error("usage: bun run scripts/package-release.ts <tag>");

const targets = readdirSync(releaseDir).filter((d) => d.startsWith("bun-"));
if (targets.length === 0) throw new Error(`no compiled targets under ${releaseDir}`);

for (const target of targets) {
  const platform = target.replace(/^bun-/, "");
  const isWindows = platform.startsWith("windows");
  const binary = join(releaseDir, target, isWindows ? "kura.exe" : "kura");
  if (!existsSync(binary)) throw new Error(`binary not found: ${binary}`);

  const installer = isWindows ? "install.ps1" : "install.sh";
  copyFileSync(join(root, "scripts", installer), join(releaseDir, target, installer));

  const zipName = `kura-${tag}-${platform}.zip`;
  const proc = Bun.spawnSync(
    ["zip", "-j", join("..", zipName), isWindows ? "kura.exe" : "kura", installer],
    { cwd: join(releaseDir, target), stdout: "inherit", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) throw new Error(`zip failed for ${target}`);
  console.error(`packaged: release/${zipName}`);
}
