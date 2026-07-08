import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import { setProviderForTests } from "../src/core/llm/provider";
import { distAssetResolver, startServer } from "../src/server/http";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");

describe("ブラウザ UI ビルドパイプライン (SPEC §8)", () => {
  test("bun run build:client が dist/index.html と dist/index.js を生成する", () => {
    const proc = Bun.spawnSync(["bun", "run", "build:client"], { cwd: root });
    expect(proc.exitCode).toBe(0);
    expect(existsSync(join(dist, "index.html"))).toBe(true);
    expect(existsSync(join(dist, "index.js"))).toBe(true);
    expect(existsSync(join(dist, "index.css"))).toBe(true);
  });

  test("startServer + distAssetResolver が dist を配信し SPA フォールバックする", async () => {
    const { db } = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 });
    setProviderForTests(null);
    const server = startServer({
      db,
      tokenizer: "trigram",
      config: defaultConfig(),
      port: 0,
      assets: distAssetResolver(dist),
    });
    try {
      const home = await fetch(`${server.url}/`);
      expect(home.status).toBe(200);
      expect(await home.text()).toContain('<div id="app">');

      const js = await fetch(`${server.url}/index.js`);
      expect(js.status).toBe(200);
      expect(js.headers.get("content-type")).toContain("text/javascript");

      const css = await fetch(`${server.url}/index.css`);
      expect(css.status).toBe(200);
      expect(css.headers.get("content-type")).toContain("text/css");

      // 未知のクライアントルートは index.html にフォールバック
      const fallback = await fetch(`${server.url}/docs/abc12345`);
      expect(fallback.status).toBe(200);
      expect(fallback.headers.get("content-type")).toContain("text/html");
      expect(await fallback.text()).toContain('<div id="app">');
    } finally {
      server.stop();
      setProviderForTests(undefined);
      db.close();
    }
  });
});
