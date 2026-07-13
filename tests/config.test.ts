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

  test("listConfigEntries returns a flat key list", () => {
    const keys = listConfigEntries(defaultConfig()).map(([k]) => k);
    expect(keys).toContain("general.default_bucket");
    expect(keys).toContain("llm.models.reranker");
    expect(keys).toContain("clip.path");
    expect(keys).toContain("browser.port");
  });
});
