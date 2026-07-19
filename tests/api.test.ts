import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBucket } from "../src/core/buckets";
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

  test("GET /api/insights (no provider: orphans, untagged, unfiled, broken links, dupes)", async () => {
    // Linked to nothing, tagged with a near-duplicate of an existing tag, left at the root
    createDocument(db, {
      title: "孤立したメモ",
      content:
        "どこからもリンクされていない。[[存在しないページ]] へのリンクだけがある。 #tech/dbs",
      bucket: "main",
    });
    createDocument(db, {
      title: "タグなしメモ",
      content: "分類していない下書き。",
      bucket: "main",
    });

    const { status, body } = await api("/api/insights?bucket=main");
    expect(status).toBe(200);

    // The two fixture documents link to each other; the two new ones do not
    expect(body.orphans.docs.map((d: { title: string }) => d.title).sort()).toEqual([
      "タグなしメモ",
      "孤立したメモ",
    ]);
    expect(body.untagged.docs.map((d: { title: string }) => d.title)).toEqual(["タグなしメモ"]);
    // Every fixture document sits at the bucket root
    expect(body.unfiled.count).toBe(4);
    expect(body.brokenLinks.links[0].targetTitle).toBe("存在しないページ");
    expect(body.brokenLinks.links[0].sources[0].title).toBe("孤立したメモ");
    // tech/db vs tech/dbs — a plural variant
    expect(
      body.tagDuplicates.some(
        (t: { from: string; to: string }) =>
          [t.from, t.to].includes("tech/db") && [t.from, t.to].includes("tech/dbs"),
      ),
    ).toBe(true);
  });

  test("GET /api/insights is scoped to the bucket and 404s on an unknown one", async () => {
    createBucket(db, "work");
    createDocument(db, { title: "採用計画", content: "方針。", bucket: "work" });

    const work = await api("/api/insights?bucket=work");
    expect(work.body.untagged.docs.map((d: { title: string }) => d.title)).toEqual(["採用計画"]);

    const missing = await api("/api/insights?bucket=nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBeTruthy();
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

  test("POST /api/docs creates a document, retrying a taken title", async () => {
    const first = await api("/api/docs", {
      method: "POST",
      body: JSON.stringify({ title: "無題", bucket: "main" }),
    });
    expect(first.status).toBe(201);
    expect(first.body.title).toBe("無題");
    expect(first.body.content).toBe("");
    expect(first.body.path).toBe("");

    // The browser's Ctrl+N must not fail because the last untitled document is still untitled
    const second = await api("/api/docs", {
      method: "POST",
      body: JSON.stringify({ title: "無題", bucket: "main" }),
    });
    expect(second.status).toBe(201);
    expect(second.body.title).toBe("無題 (2)");

    const blank = await api("/api/docs", {
      method: "POST",
      body: JSON.stringify({ title: "  ", bucket: "main" }),
    });
    expect(blank.status).toBe(400);

    const missing = await api("/api/docs", {
      method: "POST",
      body: JSON.stringify({ title: "メモ", bucket: "nope" }),
    });
    expect(missing.status).toBe(404);
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

  test("aliases: exposed in doc JSON and diff-synced by PUT", async () => {
    const created = createDocument(db, {
      title: "検索設計",
      content: "全文検索の方針。",
      bucket: "main",
      aliases: ["FTS設計"],
    });
    const got = await api(`/api/docs/${created.key}`);
    expect(got.body.aliases).toEqual(["FTS設計"]);

    const put = await api(`/api/docs/${created.key}`, {
      method: "PUT",
      body: JSON.stringify({ aliases: ["全文検索設計"] }),
    });
    expect(put.status).toBe(200);
    expect(put.body.aliases).toEqual(["全文検索設計"]);
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

  test("GET /api/tags?bucket= counts inside one bucket", async () => {
    createBucket(db, "work");
    createDocument(db, {
      title: "週次ミーティング議事録",
      content: "来期の設計方針を確認した。 #work/議事録",
      bucket: "work",
    });

    const scoped = await api("/api/tags?bucket=work");
    expect(scoped.body.map((t: { path: string }) => t.path)).toEqual(["work/議事録"]);

    const tree = await api("/api/tags?tree=1&bucket=main");
    expect(tree.body.map((n: { segment: string }) => n.segment)).toEqual(["tech"]);
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

  test("GET /api/docs?prefix= filters by document path (descendants included)", async () => {
    createDocument(db, { title: "記事", content: "x", bucket: "main", path: "clips/技術" });
    const { body } = await api("/api/docs?prefix=clips");
    expect(body.total).toBe(1);
    expect(body.docs[0].path).toBe("clips/技術");
    const none = await api("/api/docs?prefix=%E3%81%AA%E3%81%97");
    expect(none.body.total).toBe(0);
  });

  test("doc JSON carries path ('' for the bucket root)", async () => {
    const { body } = await api("/api/docs");
    expect(body.docs.every((d: { path: string }) => d.path === "")).toBe(true);
  });

  test("GET /api/resolve resolves full paths and unique titles", async () => {
    const doc = createDocument(db, { title: "記事", content: "x", bucket: "main", path: "clips" });
    const byFull = await api(`/api/resolve?doc=${encodeURIComponent("clips/記事")}`);
    expect(byFull.status).toBe(200);
    expect(byFull.body.key).toBe(doc.key);
    const byTitle = await api(`/api/resolve?doc=${encodeURIComponent("記事")}`);
    expect(byTitle.body.key).toBe(doc.key);
  });

  test("GET /api/docs/tree returns the per-bucket path hierarchy", async () => {
    createDocument(db, { title: "記事", content: "x", bucket: "main", path: "clips/技術" });
    const { status, body } = await api("/api/docs/tree?bucket=main");
    expect(status).toBe(200);
    const clips = body.find((n: { segment: string }) => n.segment === "clips");
    expect(clips.total).toBe(1);
    expect(clips.children[0].segment).toBe("技術");
    expect(clips.children[0].children[0].key).toBeTruthy();
    // The two root documents from the fixture appear as leaves
    expect(body.filter((n: { key?: string }) => n.key).length).toBe(2);

    const missing = await api("/api/docs/tree");
    expect(missing.status).toBe(400);
  });

  test("GET /api/resolve returns 404 for unknown and 409 for ambiguous specs", async () => {
    createDocument(db, { title: "記事", content: "1", bucket: "main", path: "a" });
    createDocument(db, { title: "記事", content: "2", bucket: "main", path: "b" });
    const missing = await api(`/api/resolve?doc=${encodeURIComponent("存在しない")}`);
    expect(missing.status).toBe(404);
    const ambiguous = await api(`/api/resolve?doc=${encodeURIComponent("記事")}`);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error).toContain("ambiguous");
  });

  test("PUT /api/docs/:key moves a document to another path", async () => {
    const doc = createDocument(db, { title: "記事", content: "x", bucket: "main" });
    const moved = await api(`/api/docs/${doc.key}`, {
      method: "PUT",
      body: JSON.stringify({ path: "clips/技術" }),
    });
    expect(moved.status).toBe(200);
    expect(moved.body.path).toBe("clips/技術");

    // '' is a move back to the bucket root, not a no-op
    const home = await api(`/api/docs/${doc.key}`, {
      method: "PUT",
      body: JSON.stringify({ path: "" }),
    });
    expect(home.body.path).toBe("");

    // A destination that already holds the same title is a 409
    createDocument(db, { title: "衝突", content: "y", bucket: "main", path: "clips" });
    const other = createDocument(db, {
      title: "衝突",
      content: "z",
      bucket: "main",
      path: "notes",
    });
    const clash = await api(`/api/docs/${other.key}`, {
      method: "PUT",
      body: JSON.stringify({ path: "clips" }),
    });
    expect(clash.status).toBe(409);
    expect((await api(`/api/docs/${other.key}`)).body.path).toBe("notes");
  });

  test("PUT /api/docs/:key/favorite pins without touching updated_at", async () => {
    const doc = createDocument(db, { title: "WAL モード", content: "x", bucket: "main" });
    const before = await api(`/api/docs/${doc.key}`);
    expect(before.body.favorite).toBe(false);

    const pinned = await api(`/api/docs/${doc.key}/favorite`, {
      method: "PUT",
      body: JSON.stringify({ favorite: true }),
    });
    expect(pinned.status).toBe(200);
    expect(pinned.body.favorite).toBe(true);
    // Starring is not an edit: it must not reorder the "recently updated" list
    expect(pinned.body.updated_at).toBe(before.body.updated_at);

    const favorites = await api("/api/docs?favorite=1");
    expect(favorites.body.total).toBe(1);
    expect(favorites.body.docs[0].key).toBe(doc.key);

    const unpinned = await api(`/api/docs/${doc.key}/favorite`, {
      method: "PUT",
      body: JSON.stringify({ favorite: false }),
    });
    expect(unpinned.body.favorite).toBe(false);
    expect((await api("/api/docs?favorite=1")).body.total).toBe(0);

    const invalid = await api(`/api/docs/${doc.key}/favorite`, {
      method: "PUT",
      body: JSON.stringify({ favorite: "yes" }),
    });
    expect(invalid.status).toBe(400);
  });
});
