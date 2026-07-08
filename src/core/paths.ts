import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";

/** kura version (kept in sync with package.json) */
export const KURA_VERSION: string = pkg.version;

/** Data directory. Overridable via the `KURA_HOME` env var (default `~/.kura`) */
export function kuraHome(): string {
  const env = process.env.KURA_HOME;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".kura");
}

/** DB file path. Overridable via `KURA_DB` (for tests; `:memory:` is allowed) */
export function dbPath(): string {
  const env = process.env.KURA_DB;
  if (env && env.trim() !== "") return env;
  return join(kuraHome(), "kura.db");
}

/** Extraction destination for native extensions and morphological models (per version) */
export function libDir(version: string = KURA_VERSION): string {
  return join(kuraHome(), "lib", version);
}

/** Config file path */
export function configPath(): string {
  return join(kuraHome(), "config.toml");
}
