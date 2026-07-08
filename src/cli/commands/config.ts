import {
  getConfigValue,
  listConfigEntries,
  loadConfig,
  saveConfig,
  setConfigValue,
} from "../../core/config";
import { boolOpt, EXIT, NotFoundError, parseCommandArgs, UsageError } from "../args";

export const summary = "Read and write ~/.kura/config.toml";

export const usage = `Usage:
  kura config list [--json]
  kura config get <key>
  kura config set <key> <value>

Examples:
  kura config get llm.models.embedding
  kura config set general.stale_days 90`;

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv);
  const [sub = "list", ...rest] = parsed.positionals;

  const config = loadConfig();

  switch (sub) {
    case "list": {
      if (boolOpt(parsed, "json")) {
        console.log(JSON.stringify(config, null, 2));
      } else {
        for (const [key, value] of listConfigEntries(config)) {
          console.log(`${key} = ${JSON.stringify(value)}`);
        }
      }
      return EXIT.OK;
    }
    case "get": {
      const key = rest[0];
      if (!key) throw new UsageError("config get requires <key>");
      const value = getConfigValue(config, key);
      if (value === undefined) throw new NotFoundError(`unknown config key: ${key}`);
      if (boolOpt(parsed, "json")) {
        console.log(JSON.stringify(value));
      } else if (typeof value === "object") {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(String(value));
      }
      return EXIT.OK;
    }
    case "set": {
      const [key, value] = rest;
      if (!key || value === undefined) throw new UsageError("config set requires <key> <value>");
      if (!setConfigValue(config, key, value)) {
        throw new NotFoundError(`unknown config key or invalid value: ${key} = ${value}`);
      }
      saveConfig(config);
      return EXIT.OK;
    }
    default:
      throw new UsageError(`unknown subcommand: ${sub}`);
  }
}
