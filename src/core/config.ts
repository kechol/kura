import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { configPath } from "./paths";

/** SPEC §11 の設定スキーマ */
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
    browser: {
      port: 7578,
    },
  };
}

type PlainObject = Record<string, unknown>;

function isPlainObject(v: unknown): v is PlainObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 既定値の上に読み込んだ値を再帰マージ（未知キーは無視、型不一致は既定値優先） */
function mergeInto(target: PlainObject, source: PlainObject): void {
  for (const [key, defVal] of Object.entries(target)) {
    if (!(key in source)) continue;
    const srcVal = source[key];
    if (isPlainObject(defVal)) {
      if (isPlainObject(srcVal)) mergeInto(defVal, srcVal);
    } else if (typeof srcVal === typeof defVal) {
      target[key] = srcVal;
    }
  }
}

let cached: KuraConfig | null = null;

/** config.toml を読み込み、既定値とマージして返す（プロセス内キャッシュ） */
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

/** テスト用: 設定キャッシュを破棄 */
export function resetConfigCache(): void {
  cached = null;
}

function tomlScalar(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  return String(value);
}

/** 既知スキーマ限定の TOML シリアライザ（ネストしたオブジェクトはサブセクション化） */
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

/** ドット区切りキーで設定値を取得（`kura config get` 用）。無ければ undefined */
export function getConfigValue(config: KuraConfig, key: string): unknown {
  let cur: unknown = config;
  for (const part of key.split(".")) {
    if (!isPlainObject(cur) || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/** ドット区切りキーで設定値を更新（`kura config set` 用）。既存キーのみ・型維持 */
export function setConfigValue(config: KuraConfig, key: string, raw: string): boolean {
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
  if (typeof prev === "number") {
    const n = Number(raw);
    if (Number.isNaN(n)) return false;
    cur[last] = n;
  } else if (typeof prev === "boolean") {
    if (raw !== "true" && raw !== "false") return false;
    cur[last] = raw === "true";
  } else {
    cur[last] = raw;
  }
  return true;
}

/** 設定を `key = value` 形式で平坦に列挙（`kura config list` 用） */
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
