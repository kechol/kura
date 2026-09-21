import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths";

/** Config schema (docs: configuration.md) */
export interface KuraConfig {
  general: {
    default_bucket: string;
    editor: string;
    stale_days: number;
  };
  llm: {
    provider: "auto" | "ollama" | "lmstudio" | "none";
    ollama_url: string;
    lmstudio_url: string;
    models: {
      embedding: string;
      embedding_dimensions: number;
      reranker: string;
      generation: string;
    };
  };
  search: {
    rrf_k: number;
    keyword_weight: number;
    vector_weight: number;
    rerank_top_k: number;
    default_limit: number;
  };
  clip: {
    /** Document path new clips are filed under; '' saves to the bucket root */
    path: string;
  };
  browser: {
    port: number;
  };
}

export function defaultConfig(): KuraConfig {
  return {
    general: {
      default_bucket: "main",
      editor: "",
      stale_days: 180,
    },
    llm: {
      provider: "auto",
      ollama_url: "http://localhost:11434",
      lmstudio_url: "http://localhost:1234",
      models: {
        embedding: "qwen3-embedding:0.6b",
        embedding_dimensions: 1024,
        reranker: "dengcao/Qwen3-Reranker-0.6B",
        generation: "qwen3:4b",
      },
    },
    search: {
      rrf_k: 60,
      keyword_weight: 1.0,
      vector_weight: 1.0,
      rerank_top_k: 20,
      default_limit: 10,
    },
    clip: {
      path: "clips",
    },
    browser: {
      port: 7578,
    },
  };
}

type PlainObject = Record<string, unknown>;

type ConfigScalar = string | number | boolean;
type ConfigValidator = (value: ConfigScalar) => boolean;

const finite = (value: ConfigScalar): value is number =>
  typeof value === "number" && Number.isFinite(value);
const positiveInteger = (value: ConfigScalar): value is number =>
  finite(value) && Number.isSafeInteger(value) && value > 0;
const nonNegative = (value: ConfigScalar): value is number => finite(value) && value >= 0;
const nonBlank = (value: ConfigScalar): value is string =>
  typeof value === "string" && value.trim() !== "";

const CONFIG_VALIDATORS: Record<string, ConfigValidator> = {
  "general.default_bucket": (value) =>
    typeof value === "string" && /^[a-z0-9][a-z0-9-]*$/.test(value),
  "general.editor": (value) => typeof value === "string",
  "general.stale_days": positiveInteger,
  "llm.provider": (value) =>
    typeof value === "string" && ["auto", "ollama", "lmstudio", "none"].includes(value),
  "llm.ollama_url": nonBlank,
  "llm.lmstudio_url": nonBlank,
  "llm.models.embedding": nonBlank,
  "llm.models.embedding_dimensions": positiveInteger,
  "llm.models.reranker": nonBlank,
  "llm.models.generation": nonBlank,
  "search.rrf_k": nonNegative,
  "search.keyword_weight": nonNegative,
  "search.vector_weight": nonNegative,
  "search.rerank_top_k": positiveInteger,
  "search.default_limit": positiveInteger,
  "clip.path": (value) => typeof value === "string",
  "browser.port": (value) => positiveInteger(value) && value <= 65_535,
};

function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Recursively merge valid loaded leaves onto defaults (unknown/invalid values keep defaults). */
function mergeInto(target: PlainObject, source: PlainObject, prefix = ""): void {
  for (const [key, defVal] of Object.entries(target)) {
    if (!(key in source)) continue;
    const srcVal = source[key];
    const path = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(defVal)) {
      if (isPlainObject(srcVal)) mergeInto(defVal, srcVal, path);
    } else if (
      typeof srcVal === typeof defVal &&
      CONFIG_VALIDATORS[path]?.(srcVal as ConfigScalar) === true
    ) {
      target[key] = srcVal;
    }
  }
}

let cached: KuraConfig | null = null;

/** Load config.toml and merge it with the defaults (cached per process) */
export function loadConfig(path: string = configPath()): KuraConfig {
  if (cached) return cached;
  const config = defaultConfig();
  if (existsSync(path)) {
    const parsed = Bun.TOML.parse(readFileSync(path, "utf-8"));
    if (isPlainObject(parsed)) {
      mergeInto(config as unknown as PlainObject, parsed);
    }
  }
  cached = config;
  return config;
}

/** For tests: discard the config cache */
export function resetConfigCache(): void {
  cached = null;
}

function tomlScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/** TOML serializer limited to the known schema (nested objects become subsections) */
export function serializeConfig(config: KuraConfig): string {
  const lines: string[] = [];
  const walk = (obj: PlainObject, prefix: string): void => {
    const scalars = Object.entries(obj).filter(([, v]) => !isPlainObject(v));
    const sections = Object.entries(obj).filter(([, v]) => isPlainObject(v));
    if (prefix !== "" && scalars.length > 0) {
      lines.push(`[${prefix}]`);
      for (const [k, v] of scalars) lines.push(`${k} = ${tomlScalar(v)}`);
      lines.push("");
    }
    for (const [k, v] of sections) {
      walk(v as PlainObject, prefix === "" ? k : `${prefix}.${k}`);
    }
  };
  walk(config as unknown as PlainObject, "");
  return lines.join("\n");
}

export function saveConfig(config: KuraConfig, path: string = configPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeConfig(config));
  cached = null;
}

/** Get a config value by dotted key (for `kura config get`). undefined when missing */
export function getConfigValue(config: KuraConfig, key: string): unknown {
  let cur: unknown = config;
  for (const part of key.split(".")) {
    if (!isPlainObject(cur) || !Object.hasOwn(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Set a config leaf by dotted key. Existing sections cannot be replaced wholesale. */
export function setConfigValue(config: KuraConfig, key: string, raw: string): boolean {
  if (!Object.hasOwn(CONFIG_VALIDATORS, key)) return false;
  const parts = key.split(".");
  const last = parts.pop();
  if (!last) return false;
  let cur: unknown = config;
  for (const part of parts) {
    if (!isPlainObject(cur) || !isPlainObject(cur[part])) return false;
    cur = cur[part];
  }
  if (!isPlainObject(cur) || !(last in cur)) return false;
  const prev = cur[last];
  if (isPlainObject(prev)) return false;
  let next: ConfigScalar;
  if (typeof prev === "number") {
    if (raw.trim() === "") return false;
    const n = Number(raw);
    if (!Number.isFinite(n)) return false;
    next = n;
  } else if (typeof prev === "boolean") {
    if (raw !== "true" && raw !== "false") return false;
    next = raw === "true";
  } else {
    next = raw;
  }
  const validate = CONFIG_VALIDATORS[key];
  if (!validate?.(next)) return false;
  cur[last] = next;
  return true;
}

/** List the config flatly as `key = value` entries (for `kura config list`) */
export function listConfigEntries(config: KuraConfig): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  const walk = (obj: PlainObject, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix === "" ? k : `${prefix}.${k}`;
      if (isPlainObject(v)) walk(v, path);
      else entries.push([path, v]);
    }
  };
  walk(config as unknown as PlainObject, "");
  return entries;
}
