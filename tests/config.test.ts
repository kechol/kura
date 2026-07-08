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
  test("既定値が SPEC §11 と一致する", () => {
    const c = defaultConfig();
    expect(c.general.default_bucket).toBe("main");
    expect(c.general.stale_days).toBe(180);
    expect(c.llm.provider).toBe("auto");
    expect(c.llm.models.embedding).toBe("qwen3-embedding:0.6b");
    expect(c.llm.models.embedding_dimensions).toBe(1024);
    expect(c.search.rrf_k).toBe(60);
    expect(c.search.rerank_top_k).toBe(20);
    expect(c.browser.port).toBe(7578);
  });

  test("serialize → parse でラウンドトリップする", () => {
    const c = defaultConfig();
    c.general.stale_days = 90;
    c.llm.models.generation = "llama3:8b";
    const toml = serializeConfig(c);
    const parsed = Bun.TOML.parse(toml) as Record<string, unknown>;
    expect(parsed).toEqual(JSON.parse(JSON.stringify(c)));
  });

  test("ファイルから読み込んで既定値とマージする", () => {
    const path = tempConfigPath();
    writeFileSync(path, '[general]\nstale_days = 30\n\n[llm.models]\ngeneration = "qwen3:8b"\n');
    resetConfigCache();
    const c = loadConfig(path);
    expect(c.general.stale_days).toBe(30);
    expect(c.llm.models.generation).toBe("qwen3:8b");
    // 未指定キーは既定値のまま
    expect(c.general.default_bucket).toBe("main");
    expect(c.search.rrf_k).toBe(60);
    resetConfigCache();
  });

  test("未知キー・型不一致は無視して既定値を守る", () => {
    const path = tempConfigPath();
    writeFileSync(path, '[general]\nstale_days = "not-a-number"\nunknown_key = 1\n');
    resetConfigCache();
    const c = loadConfig(path);
    expect(c.general.stale_days).toBe(180);
    expect("unknown_key" in c.general).toBe(false);
    resetConfigCache();
  });

  test("saveConfig がファイルに書き出す", () => {
    const path = tempConfigPath();
    const c = defaultConfig();
    c.browser.port = 8080;
    saveConfig(c, path);
    expect(readFileSync(path, "utf-8")).toContain("port = 8080");
  });

  test("getConfigValue / setConfigValue がドット区切りキーを扱う", () => {
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

  test("listConfigEntries が平坦なキー一覧を返す", () => {
    const keys = listConfigEntries(defaultConfig()).map(([k]) => k);
    expect(keys).toContain("general.default_bucket");
    expect(keys).toContain("llm.models.reranker");
    expect(keys).toContain("browser.port");
  });
});
