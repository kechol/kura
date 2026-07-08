import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import { createDocument } from "../src/core/documents";
import { setProviderForTests } from "../src/core/llm/provider";
import { type KuraServer, startServer } from "../src/server/http";

let db: Database;
let server: KuraServer;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${server.url}${path}`, init);
  return { status: res.status, body: await res.json().catch(() => null) };
}

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
  setProviderForTests(null);
  createDocument(db, {
    title: "SQLite の WAL モード",
    content: "WAL は書き込みをブロックしない。[[トランザクション設計]] を参照。 #tech/db/sqlite",
    bucket: "main",
  });
  createDocument(db, {
    title: "トランザクション設計",
    content: "分離レベルの話。 #tech/db",
    bucket: "main",
  });
  server = startServer({ db, tokenizer: "trigram", config: defaultConfig(), port: 0 });
});

afterEach(() => {
  server.stop();
  setProviderForTests(undefined);
  db.close();
});

describe("REST API (docs: http-api.md)", () => {
  test("GET /api/stats", async () => {
    const { status, body } = await api("/api/stats");
    expect(status).toBe(200);
    expect(body.documents).toBe(2);
    expect(body.tokenizer).toBe("trigram");
  });

  test("GET /api/buckets", async () => {
    const { body } = await api("/api/buckets");
    expect(body[0].name).toBe("main");
    expect(body[0].documents).toBe(2);
  });

  test("GET /api/docs filtering and pagination", async () => {
    const all = await api("/api/docs");
    expect(all.body.total).toBe(2);
    expect(all.body.docs.length).toBe(2);

    const paged = await api("/api/docs?per=1&page=2");
    expect(paged.body.docs.length).toBe(1);
    expect(paged.body.total).toBe(2);

    const tagged = await api("/api/docs?tag=tech/db/sqlite");
    expect(tagged.body.total).toBe(1);
    expect(tagged.body.docs[0].title).toBe("SQLite の WAL モード");

    const badSort = await api("/api/docs?sort=bogus");
    expect(badSort.status).toBe(400);
  });

  test("GET/PUT/DELETE /api/docs/:key", async () => {
    const list = await api("/api/docs");
    const key: string = list.body.docs.find(
      (d: { title: string }) => d.title === "トランザクション設計",
    ).key;

    const got = await api(`/api/docs/${key}`);
    expect(got.status).toBe(200);
    expect(got.body.content).toContain("分離レベル");
    expect(got.body.access_count).toBe(1);

    const put = await api(`/api/docs/${key}`, {
      method: "PUT",
      body: JSON.stringify({
        content: "更新済み本文。 #tech/db",
        tags: ["tech/db", "レビュー済み"],
      }),
    });
    expect(put.status).toBe(200);
    expect(put.body.content).toContain("更新済み");
    expect(put.body.tags).toContain("レビュー済み");

    // Tag diff sync: tags removed in the editor are deleted
    const put2 = await api(`/api/docs/${key}`, {
      method: "PUT",
      body: JSON.stringify({ tags: ["tech/db"] }),
    });
    expect(put2.body.tags).toEqual(["tech/db"]);

    const del = await api(`/api/docs/${key}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const gone = await api(`/api/docs/${key}`);
    expect(gone.status).toBe(404);
  });

  test("GET /api/docs/:key/related", async () => {
    const list = await api("/api/docs");
    const key: string = list.body.docs.find(
      (d: { title: string }) => d.title === "トランザクション設計",
    ).key;
    const { body } = await api(`/api/docs/${key}/related`);
    expect(body.backlinks.length).toBe(1);
    expect(body.backlinks[0].title).toBe("SQLite の WAL モード");
  });

  test("GET /api/search (keyword / hybrid / invalid mode / vector error)", async () => {
    const kw = await api(`/api/search?q=${encodeURIComponent("トランザクション")}`);
    expect(kw.status).toBe(200);
    expect(kw.body.hits[0].title).toBe("トランザクション設計");

    const hybrid = await api(`/api/search?q=${encodeURIComponent("トランザクション")}&mode=hybrid`);
    expect(hybrid.status).toBe(200);
    expect(hybrid.body.warnings.length).toBeGreaterThan(0);

    const bad = await api("/api/search?q=x&mode=bogus");
    expect(bad.status).toBe(400);

    // vector mode without a provider returns 500 (LLMUnavailable)
    const vec = await api(`/api/search?q=${encodeURIComponent("トランザクション")}&mode=vector`);
    expect(vec.status).toBe(500);
  });

  test("GET /api/tags and /api/tags?tree=1", async () => {
    const flat = await api("/api/tags");
    expect(flat.body.map((t: { path: string }) => t.path)).toContain("tech/db/sqlite");

    const tree = await api("/api/tags?tree=1");
    const tech = tree.body.find((n: { segment: string }) => n.segment === "tech");
    expect(tech.total).toBe(2);
  });

  test("GET /api/graph", async () => {
    const { body } = await api("/api/graph");
    expect(body.nodes.length).toBe(2);
    expect(body.edges.length).toBe(1);
    const linked = body.nodes.find((n: { degree: number }) => n.degree > 0);
    expect(linked).toBeTruthy();
    expect(typeof body.nodes[0].stale).toBe("boolean");
  });

  test("SPA fallback (placeholder when dist is absent)", async () => {
    const res = await fetch(`${server.url}/some/client/route`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("unknown /api paths return 404 JSON", async () => {
    const { status, body } = await api("/api/nope");
    expect(status).toBe(404);
    expect(body.error).toBeTruthy();
  });
});
