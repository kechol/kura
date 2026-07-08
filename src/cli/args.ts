import { parseArgs } from "node:util";
import { UsageError } from "../core/errors";

/** 終了コード規約（SPEC §7） */
export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  NO_LLM: 4,
} as const;

export { ConflictError, LLMUnavailableError, NotFoundError, UsageError } from "../core/errors";

export type OptionSpec = Record<
  string,
  {
    type: "string" | "boolean";
    short?: string;
    multiple?: boolean;
    default?: string | boolean | string[];
  }
>;

export interface Parsed {
  values: Record<string, string | boolean | Array<string | boolean> | undefined>;
  positionals: string[];
}

/**
 * util.parseArgs の薄いラッパー。不正なオプションは UsageError に変換する。
 * すべてのコマンドで `--json` / `--help` を受け付ける。
 */
export function parseCommandArgs(argv: string[], options: OptionSpec = {}): Parsed {
  const merged: OptionSpec = {
    json: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    ...options,
  };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: merged,
      allowPositionals: true,
      strict: true,
    });
    return { values, positionals };
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
}

/** 文字列オプションの取り出し（未指定は undefined） */
export function strOpt(parsed: Parsed, name: string): string | undefined {
  const v = parsed.values[name];
  return typeof v === "string" ? v : undefined;
}

/** 真偽オプションの取り出し */
export function boolOpt(parsed: Parsed, name: string): boolean {
  return parsed.values[name] === true;
}

/** 数値オプションの取り出し（parse 不能は UsageError） */
export function intOpt(parsed: Parsed, name: string): number | undefined {
  const v = strOpt(parsed, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new UsageError(`--${name} must be an integer, got: ${v}`);
  return n;
}

/** カンマ区切りリストオプション（`--tags a,b`）の取り出し */
export function listOpt(parsed: Parsed, name: string): string[] {
  const v = strOpt(parsed, name);
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
