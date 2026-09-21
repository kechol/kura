import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultConfig,
  getConfigValue,
  listConfigEntries,
  loadConfig,
  resetConfigCache,
  saveConfig,
  serializeConfig,
  setConfigValue,
} from "../src/core/config";

function tempConfigPath(): string {
  return join(mkdtempSync(join(tmpdir(), "kura-test-")), "config.toml");
}

describe("config", () => {
  test("defaults match the documented values (docs: configuration.md)", () => {
    const c = defaultConfig();
    expect(c.general.default_bucket).toBe("main");
    expect(c.general.stale_days).toBe(180);
    expect(c.llm.provider).toBe("auto");
    expect(c.llm.models.embedding).toBe("qwen3-embedding:0.6b");
    expect(c.llm.models.embedding_dimensions).toBe(1024);
    expect(c.search.rrf_k).toBe(60);
    expect(c.search.rerank_top_k).toBe(20);
    expect(c.clip.path).toBe("clips");
    expect(c.browser.port).toBe(7578);
  });

  test("round-trips through serialize -> parse", () => {
    const c = defaultConfig();
    c.general.stale_days = 90;
    c.llm.models.generation = "llama3:8b";
    const toml = serializeConfig(c);
    const parsed = Bun.TOML.parse(toml) as Record<string, unknown>;
    expect(parsed).toEqual(JSON.parse(JSON.stringify(c)));
  });

  test("loads from a file and merges with defaults", () => {
    const path = tempConfigPath();
    writeFileSync(path, '[general]\nstale_days = 30\n\n[llm.models]\ngeneration = "qwen3:8b"\n');
    resetConfigCache();
    const c = loadConfig(path);
    expect(c.general.stale_days).toBe(30);
    expect(c.llm.models.generation).toBe("qwen3:8b");
    // Unspecified keys keep their defaults
    expect(c.general.default_bucket).toBe("main");
    expect(c.search.rrf_k).toBe(60);
    resetConfigCache();
  });

  test("ignores unknown keys and type mismatches, keeping defaults", () => {
    const path = tempConfigPath();
    writeFileSync(path, '[general]\nstale_days = "not-a-number"\nunknown_key = 1\n');
    resetConfigCache();
    const c = loadConfig(path);
    expect(c.general.stale_days).toBe(180);
    expect("unknown_key" in c.general).toBe(false);
    resetConfigCache();
  });

  test("loaded enum and numeric range violations keep their defaults", () => {
    const path = tempConfigPath();
    writeFileSync(
      path,
      [
        "[general]",
        "stale_days = 0",
        "[llm]",
        'provider = "remote"',
        "[llm.models]",
        "embedding_dimensions = -4",
        "[search]",
        'rrf_k = "broken"',
        "rerank_top_k = 1.5",
        "[browser]",
        "port = 70000",
        "",
      ].join("\n"),
    );
    resetConfigCache();
    const c = loadConfig(path);
    expect(c.general.stale_days).toBe(180);
    expect(c.llm.provider).toBe("auto");
    expect(c.llm.models.embedding_dimensions).toBe(1024);
    expect(c.search.rrf_k).toBe(60);
    expect(c.search.rerank_top_k).toBe(20);
    expect(c.browser.port).toBe(7578);
    resetConfigCache();
  });

  test("saveConfig writes to a file", () => {
    const path = tempConfigPath();
    const c = defaultConfig();
    c.browser.port = 8080;
    saveConfig(c, path);
    expect(readFileSync(path, "utf-8")).toContain("port = 8080");
  });

  test("getConfigValue / setConfigValue handle dotted keys", () => {
    const c = defaultConfig();
    expect(getConfigValue(c, "llm.models.embedding_dimensions")).toBe(1024);
    expect(getConfigValue(c, "nope.nope")).toBeUndefined();

    expect(setConfigValue(c, "search.rrf_k", "42")).toBe(true);
    expect(c.search.rrf_k).toBe(42);
    expect(setConfigValue(c, "search.rrf_k", "abc")).toBe(false);
    expect(setConfigValue(c, "general.editor", "nvim")).toBe(true);
    expect(c.general.editor).toBe("nvim");
    expect(setConfigValue(c, "unknown.key", "v")).toBe(false);
  });

  test("inherited object properties are not config keys", () => {
    const c = defaultConfig();
    for (const key of ["constructor", "toString", "valueOf", "__proto__", "general.toString"]) {
      expect(setConfigValue(c, key, "変更禁止")).toBe(false);
      expect(getConfigValue(c, key)).toBeUndefined();
    }
    expect(Object.hasOwn(c, "constructor")).toBe(false);
  });

  test("setConfigValue accepts valid boundaries and rejects sections and invalid scalars atomically", () => {
    const c = defaultConfig();
    const original = serializeConfig(c);
    for (const [key, value] of [
      ["search", "broken"],
      ["llm.models", "broken"],
      ["general.stale_days", ""],
      ["general.stale_days", "1.5"],
      ["general.stale_days", "Infinity"],
      ["general.stale_days", "NaN"],
      ["general.default_bucket", "Main"],
      ["llm.provider", "remote"],
      ["llm.ollama_url", "   "],
      ["llm.models.embedding", ""],
      ["llm.models.embedding_dimensions", "0"],
      ["search.rrf_k", ""],
      ["search.keyword_weight", "   "],
      ["search.keyword_weight", "Infinity"],
      ["search.vector_weight", "NaN"],
      ["search.rrf_k", "-1"],
      ["search.keyword_weight", "-0.1"],
      ["search.rerank_top_k", "2.5"],
      ["search.default_limit", "0"],
      ["browser.port", "0"],
      ["browser.port", "65536"],
    ] as const) {
      expect(setConfigValue(c, key, value)).toBe(false);
      expect(serializeConfig(c)).toBe(original);
    }

    expect(setConfigValue(c, "general.stale_days", "1")).toBe(true);
    expect(setConfigValue(c, "llm.models.embedding_dimensions", "1")).toBe(true);
    expect(setConfigValue(c, "search.rrf_k", "0")).toBe(true);
    expect(setConfigValue(c, "search.keyword_weight", "0")).toBe(true);
    expect(setConfigValue(c, "search.vector_weight", "0.5")).toBe(true);
    expect(setConfigValue(c, "search.rerank_top_k", "1")).toBe(true);
    expect(setConfigValue(c, "search.default_limit", "1")).toBe(true);
    expect(setConfigValue(c, "browser.port", "65535")).toBe(true);
    expect(setConfigValue(c, "llm.provider", "none")).toBe(true);
    expect(setConfigValue(c, "clip.path", "")).toBe(true);
  });

  test("listConfigEntries returns a flat key list", () => {
    const keys = listConfigEntries(defaultConfig()).map(([k]) => k);
    expect(keys).toContain("general.default_bucket");
    expect(keys).toContain("llm.models.reranker");
    expect(keys).toContain("clip.path");
    expect(keys).toContain("browser.port");
  });
});
