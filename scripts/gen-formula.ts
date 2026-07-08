#!/usr/bin/env bun
/**
 * Generate the Homebrew formula for kura from the release archives
 * (docs: build-and-release.md).
 *
 * Reads release/SHA256SUMS.txt (written by scripts/package-release.ts) and
 * emits a formula that points at the GitHub Release download URLs for the
 * given tag, with the matching sha256 for each macOS / Linux archive.
 * Windows is not distributed via Homebrew, so it is not referenced.
 *
 * The formula declares `depends_on "sqlite"`: on macOS kura loads SQLite
 * extensions, which Apple's bundled SQLite cannot do, so it needs the
 * Homebrew keg at /opt/homebrew/opt/sqlite (docs: native-extensions.md).
 *
 * Usage: bun run scripts/gen-formula.ts <tag> [--out <path>]
 *   <tag>  e.g. v0.2.0  (the leading `v` is stripped for the formula version)
 *   --out  formula output path (default: release/kura.rb)
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const root = join(import.meta.dir, "..");
const REPO = "kechol/kura";

// Homebrew targets: archive platform → (os block, cpu block).
const PLATFORMS = [
  { archive: "kura-darwin-arm64.tar.gz", os: "macos", cpu: "arm" },
  { archive: "kura-darwin-x64.tar.gz", os: "macos", cpu: "intel" },
  { archive: "kura-linux-arm64.tar.gz", os: "linux", cpu: "arm" },
  { archive: "kura-linux-x64.tar.gz", os: "linux", cpu: "intel" },
] as const;

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: { out: { type: "string" } },
});

const tag = positionals[0];
if (!tag) throw new Error("usage: bun run scripts/gen-formula.ts <tag> [--out <path>]");
const version = tag.replace(/^v/, "");

// Parse SHA256SUMS.txt: `<sha256>  <filename>` per line.
const sumsPath = join(root, "release", "SHA256SUMS.txt");
if (!existsSync(sumsPath)) throw new Error(`missing ${sumsPath}; run package-release.ts first`);
const sums = new Map<string, string>();
for (const line of readFileSync(sumsPath, "utf-8").split("\n")) {
  const m = line.match(/^([0-9a-f]{64})\s+(\S+)$/);
  const sha = m?.[1];
  const name = m?.[2];
  if (sha && name) sums.set(name, sha);
}

function url(archive: string): string {
  return `https://github.com/${REPO}/releases/download/${tag}/${archive}`;
}

// Emit an on_macos / on_linux block with nested on_arm / on_intel.
function osBlock(os: "macos" | "linux"): string {
  const arm = PLATFORMS.find((p) => p.os === os && p.cpu === "arm");
  const intel = PLATFORMS.find((p) => p.os === os && p.cpu === "intel");
  const lines: string[] = [`  on_${os} do`];
  for (const [macro, p] of [
    ["on_arm", arm],
    ["on_intel", intel],
  ] as const) {
    if (!p) continue;
    const sha = sums.get(p.archive);
    if (!sha) throw new Error(`no sha256 for ${p.archive} in SHA256SUMS.txt`);
    lines.push(
      `    ${macro} do`,
      `      url "${url(p.archive)}"`,
      `      sha256 "${sha}"`,
      "    end",
    );
  }
  lines.push("  end");
  return lines.join("\n");
}

const formula = `class Kura < Formula
  desc "Local knowledge management CLI with Japanese-aware hybrid search"
  homepage "https://github.com/${REPO}"
  version "${version}"
  license any_of: ["MIT", "Apache-2.0"]

${osBlock("macos")}

${osBlock("linux")}

  # macOS needs the Homebrew SQLite keg: Apple's bundled SQLite cannot load
  # the sqlite-vec / sqlite-vaporetto extensions kura relies on.
  depends_on "sqlite"

  def install
    bin.install "kura"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/kura --version")
  end
end
`;

const out = values.out ?? join(root, "release", "kura.rb");
await Bun.write(out, formula);
console.error(`wrote: ${out}`);
