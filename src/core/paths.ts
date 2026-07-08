import { homedir } from "node:os";
import { join } from "node:path";
import pkg from "../../package.json";

/** kura のバージョン（package.json と同期） */
export const KURA_VERSION: string = pkg.version;

/** データディレクトリ。`KURA_HOME` 環境変数で上書き可（既定 `~/.kura`） */
export function kuraHome(): string {
  const env = process.env.KURA_HOME;
  if (env && env.trim() !== "") return env;
  return join(homedir(), ".kura");
}

/** DB ファイルパス。`KURA_DB` で個別上書き可（テスト用。`:memory:` も可） */
export function dbPath(): string {
  const env = process.env.KURA_DB;
  if (env && env.trim() !== "") return env;
  return join(kuraHome(), "kura.db");
}

/** ネイティブ拡張・形態素モデルの展開先（バージョン別） */
export function libDir(version: string = KURA_VERSION): string {
  return join(kuraHome(), "lib", version);
}

/** 設定ファイルパス */
export function configPath(): string {
  return join(kuraHome(), "config.toml");
}
