import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLoadablePath } from "sqlite-vec";
import { embeddedVecLib, embeddedVecLibName } from "../generated/embedded";
import { libDir } from "./paths";

/** Pinned sqlite-vaporetto release (docs: native-extensions.md: SHA256 verification required) */
export const VAPORETTO_VERSION = "v0.4.0";

interface VaporettoAsset {
  file: string;
  sha256: string;
  /** Extension library file name inside the archive */
  lib: string;
}

/** GitHub Releases asset definitions (-with-model builds: morphological model embedded in the dylib) */
const VAPORETTO_ASSETS: Record<string, VaporettoAsset> = {
  "darwin-arm64": {
    file: `sqlite-vaporetto-${VAPORETTO_VERSION}-macos-aarch64-with-model.tar.gz`,
    sha256: "e38146ff5f1cf1da72ca19640baa7bdd0e753125185a7b51d68054baa02df897",
    lib: "libsqlite_vaporetto.dylib",
  },
  "linux-x64": {
    file: `sqlite-vaporetto-${VAPORETTO_VERSION}-linux-x86_64-with-model.tar.gz`,
    sha256: "2a373575ea12d3617ce495c428f87ac714ada38c5f87627f9e1434c1b12677d1",
    lib: "libsqlite_vaporetto.so",
  },
  "linux-arm64": {
    file: `sqlite-vaporetto-${VAPORETTO_VERSION}-linux-aarch64-with-model.tar.gz`,
    sha256: "bb79343bdb430bb120a4a9d3fe42a954685813be74fb39030ca7c1ca4e8975b0",
    lib: "libsqlite_vaporetto.so",
  },
  "win32-x64": {
    file: `sqlite-vaporetto-${VAPORETTO_VERSION}-windows-x86_64-with-model.zip`,
    sha256: "57d16cf3b6cf81100170ea9fb75731caafa634b11b50ab629fc60fb1ce3a2e96",
    lib: "sqlite_vaporetto.dll",
  },
};

export const VAPORETTO_ENTRY_POINT = "sqlite3_vaporetto_init";

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

/** Whether vaporetto is available on this platform (darwin-x64 has no binary; falls back to trigram) */
export function vaporettoSupported(): boolean {
  return platformKey() in VAPORETTO_ASSETS;
}

/** Expected path of the extracted vaporetto extension */
export function vaporettoLibPath(): string | null {
  const asset = VAPORETTO_ASSETS[platformKey()];
  if (!asset) return null;
  return join(libDir(), asset.lib);
}

async function sha256File(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, {
    headers: { "User-Agent": "kura-cli" },
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  await Bun.write(dest, res);
}

/**
 * Provision the sqlite-vaporetto extension under ~/.kura/lib/<ver>/.
 * Returns the path if already extracted; null on unsupported platforms or when
 * not extracted and download=false. Throws if SHA256 verification fails on download.
 */
export async function ensureVaporetto(opts: { download?: boolean } = {}): Promise<string | null> {
  const download = opts.download ?? true;
  const asset = VAPORETTO_ASSETS[platformKey()];
  const dest = vaporettoLibPath();
  if (!asset || !dest) return null;
  if (existsSync(dest)) return dest;
  if (!download) return null;

  const url = `https://github.com/hotchpotch/sqlite-vaporetto/releases/download/${VAPORETTO_VERSION}/${asset.file}`;
  const workDir = join(tmpdir(), `kura-vaporetto-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  try {
    const archive = join(workDir, asset.file);
    console.error(`Downloading sqlite-vaporetto ${VAPORETTO_VERSION} (${asset.file})...`);
    await downloadTo(url, archive);

    const actual = await sha256File(archive);
    if (actual !== asset.sha256) {
      throw new Error(
        `SHA256 mismatch for ${asset.file}\n  expected: ${asset.sha256}\n  actual:   ${actual}`,
      );
    }

    // tar can extract both .tar.gz and .zip (Windows 10+ ships bsdtar)
    const proc = Bun.spawnSync(["tar", "-xf", archive, "-C", workDir]);
    if (proc.exitCode !== 0) {
      throw new Error(`failed to extract ${asset.file}: ${proc.stderr.toString()}`);
    }
    const extractedLib = join(workDir, asset.file.replace(/\.(tar\.gz|zip)$/, ""), asset.lib);
    if (!existsSync(extractedLib)) {
      throw new Error(`extension library not found in archive: ${asset.lib}`);
    }
    mkdirSync(libDir(), { recursive: true });
    renameSync(extractedLib, dest);
    return dest;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Return a loadable path for the sqlite-vec extension.
 * In the compiled binary, extract the embedded asset to ~/.kura/lib/<ver>/ and return it
 * (dlopen cannot load from the embedded FS, docs: native-extensions.md). In dev, use the node_modules prebuild.
 */
export function vecLoadablePath(): string {
  if (embeddedVecLib && embeddedVecLibName !== "") {
    const dest = join(libDir(), embeddedVecLibName);
    if (!existsSync(dest)) {
      mkdirSync(libDir(), { recursive: true });
      writeFileSync(dest, readFileSync(embeddedVecLib));
    }
    return dest;
  }
  return getLoadablePath();
}
