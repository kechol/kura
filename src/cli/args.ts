import { parseArgs } from "node:util";
import { UsageError } from "../core/errors";

/** Exit code conventions (SPEC §7) */
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
 * Thin wrapper around util.parseArgs. Invalid options are converted to UsageError.
 * Every command accepts `--json` / `--help`.
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

/** Read a string option (undefined when not given) */
export function strOpt(parsed: Parsed, name: string): string | undefined {
  const v = parsed.values[name];
  return typeof v === "string" ? v : undefined;
}

/** Read a boolean option */
export function boolOpt(parsed: Parsed, name: string): boolean {
  return parsed.values[name] === true;
}

/** Read an integer option (UsageError when unparsable) */
export function intOpt(parsed: Parsed, name: string): number | undefined {
  const v = strOpt(parsed, name);
  if (v === undefined) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) throw new UsageError(`--${name} must be an integer, got: ${v}`);
  return n;
}

/** Read a comma-separated list option (`--tags a,b`) */
export function listOpt(parsed: Parsed, name: string): string[] {
  const v = strOpt(parsed, name);
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}
