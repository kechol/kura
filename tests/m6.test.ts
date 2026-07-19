import type { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { extractContent, fetchAndExtract } from "../src/core/clip/extract";
import { formatClip, htmlToMarkdown } from "../src/core/clip/format";
import { defaultConfig, type KuraConfig } from "../src/core/config";
import { openDatabase, setMeta } from "../src/core/db";
import {
  fixContentHashes,
  gcOrphans,
  rebuildFtsIfNeeded,
  recreateVecIfModelChanged,
  resolveAllUnresolvedLinks,
  retokenizeFts,
} from "../src/core/doctor";
import { createDocument } from "../src/core/documents";
import { auditTags, levenshtein } from "../src/core/gardening";
import type { LLMProvider, Message } from "../src/core/llm/provider";
import { staleDocuments, staleScore } from "../src/core/stale";
import { suggestTagsForText } from "../src/core/tagging";

const PAGE_HTML = `<!doctype html>
<html><head><title>SQLite の WAL モード徹底解説 | Tech Blog</title></head>
<body>
<nav>ナビゲーション</nav>
<article>
<h1>SQLite の WAL モード徹底解説</h1>
<p>${"WAL モードは書き込みと読み取りを並行して行える仕組みである。チェックポイントの挙動を理解することが重要だ。".repeat(5)}</p>
<h2>チェックポイント</h2>
<p>${"チェックポイントは WAL ファイルの内容を本体データベースへ反映する処理である。".repeat(5)}</p>
<pre><code>PRAGMA journal_mode = WAL;</code></pre>
</article>
<footer>フッター 広告</footer>
</body></html>`;

class ClipMockProvider implements LLMProvider {
  name = "ollama" as const;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async hasModel(): Promise<boolean> {
    return true;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    // For the tag audit: give semantically close tags (db / database) same-direction vectors
    return texts.map((t) => {
      const v = new Float32Array(4);
      if (/db|database|データベース/.test(t)) v[0] = 1;
      else if (/web/.test(t)) v[1] = 1;
      else v[3] = 1;
      return v;
    });
  }
  async chat(messages: Message[]): Promise<string> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("タグ付け")) {
      return '["tech/db/sqlite", "tech/performance"]';
    }
    return "TITLE: SQLite の WAL モード徹底解説\n\n## 概要\nWAL モードの整形済み本文。チェックポイントの挙動を理解することで、書き込みと読み取りの並行性を最大限に活かせる。運用時は wal ファイルサイズの監視も重要になる。";
  }
}

let db: Database;
let config: KuraConfig;
const mock = new ClipMockProvider();

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
  config = defaultConfig();
  config.llm.models.embedding_dimensions = 4;
});

afterEach(() => {
  db.close();
});

describe("clip extract/format", () => {
  let server: ReturnType<typeof Bun.serve>;

  beforeAll(() => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(PAGE_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    });
  });
  afterAll(() => {
    server.stop(true);
  });

  test("readability extracts the body and title, dropping nav and footer", () => {
    const page = extractContent("https://example.com/wal", PAGE_HTML);
    expect(page.title).toContain("WAL モード徹底解説");
    expect(page.contentHtml).toContain("チェックポイント");
    expect(page.contentHtml).not.toContain("ナビゲーション");
  });

  test("fetchAndExtract fetches from a local HTTP server", async () => {
    const page = await fetchAndExtract(`http://127.0.0.1:${server.port}/article`);
    expect(page.title).toContain("WAL モード");
  });

  test("turndown fallback (--no-llm)", async () => {
    const page = extractContent("https://example.com/wal", PAGE_HTML);
    const result = await formatClip(db, mock, config, page, { noLlm: true });
    expect(result.llmFormatted).toBe(false);
    expect(result.markdown).toContain("## チェックポイント");
    expect(result.markdown).toContain("```");
  });

  test("LLM formatting (title extraction + cache)", async () => {
    const page = extractContent("https://example.com/wal", PAGE_HTML);
    const result = await formatClip(db, mock, config, page, {});
    expect(result.llmFormatted).toBe(true);
    expect(result.title).toBe("SQLite の WAL モード徹底解説");
    expect(result.markdown).toContain("整形済み本文");
    const cacheRows = db
      .prepare("SELECT COUNT(*) AS n FROM llm_cache WHERE purpose = 'clip'")
      .get() as { n: number };
    expect(cacheRows.n).toBe(1);
  });

  test("tag suggestions (prompt prefers existing tags, cached under purpose 'tag')", async () => {
    const tags = await suggestTagsForText(db, mock, config, "WAL の記事", ["tech/db/sqlite"]);
    expect(tags).toEqual(["tech/db/sqlite", "tech/performance"]);
    const cacheRows = db
      .prepare("SELECT COUNT(*) AS n FROM llm_cache WHERE purpose = 'tag'")
      .get() as { n: number };
    expect(cacheRows.n).toBe(1);
  });

  test("htmlToMarkdown strips script tags", () => {
    const md = htmlToMarkdown("<p>本文</p><script>alert(1)</script>");
    expect(md).toBe("本文");
  });
});

describe("gardening (docs: self-healing.md)", () => {
  test("levenshtein", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("同じ", "同じ")).toBe(0);
  });

  test("lists merge candidates via edit distance + singular/plural + embedding similarity", async () => {
    createDocument(db, { title: "A", content: "x #tech/db #databases", bucket: "main" });
    createDocument(db, { title: "B", content: "y #tech/db #database", bucket: "main" });
    createDocument(db, { title: "C", content: "z #tech/db", bucket: "main" });

    const result = await auditTags(db, mock, config);
    expect(result.usedEmbeddings).toBe(true);
    // database/databases is a singular/plural variant
    const plural = result.merges.find((m) => m.reason.includes("singular/plural"));
    expect(plural).toBeTruthy();
    expect(plural?.to).toBe("database");
    // tech/db is attached to 3/3 = 100% of documents -> oversized
    expect(result.oversized.some((o) => o.path === "tech/db")).toBe(true);
    // Ancestor/descendant tags (tech and tech/db) are not merge candidates
    expect(result.merges.some((m) => m.from === "tech" || m.to === "tech")).toBe(false);
  });
});

describe("stale (docs: self-healing.md)", () => {
  test("staleScore decays with more usage", () => {
    expect(staleScore(360, 0, 0, 180)).toBeCloseTo(2);
    expect(staleScore(360, 10, 0, 180)).toBeLessThan(1);
    expect(staleScore(360, 0, 4, 180)).toBeLessThan(1);
  });

  test("staleDocuments returns only old, rarely accessed documents", () => {
    // 200 days ago: score > 1 when neglected, dampened below 1 when heavily accessed
    const oldDate = new Date(Date.now() - 200 * 86_400_000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    createDocument(db, {
      title: "古い放置ドキュメント",
      content: "x",
      bucket: "main",
      createdAt: oldDate,
      updatedAt: oldDate,
    });
    const fresh = createDocument(db, { title: "新しい", content: "y", bucket: "main" });
    const popular = createDocument(db, {
      title: "古いが高参照",
      content: "z",
      bucket: "main",
      updatedAt: oldDate,
    });
    db.prepare("UPDATE documents SET access_count = 100 WHERE id = ?").run(popular.id);

    const stale = staleDocuments(db, config);
    expect(stale.map((d) => d.title)).toEqual(["古い放置ドキュメント"]);
    expect(stale[0]?.staleScore).toBeGreaterThan(1);
    expect(stale.some((d) => d.key === fresh.key)).toBe(false);
  });
});

describe("doctor fixes (docs: self-healing.md)", () => {
  test("FTS row-count mismatch triggers a rebuild", () => {
    const doc = createDocument(db, { title: "T", content: "本文テキスト #tag1", bucket: "main" });
    db.prepare("DELETE FROM documents_fts WHERE rowid = ?").run(doc.id);
    const report = rebuildFtsIfNeeded(db);
    expect(report?.action).toBe("fts-rebuild");
    const row = db.prepare("SELECT tags FROM documents_fts WHERE rowid = ?").get(doc.id) as {
      tags: string;
    };
    expect(row.tags).toContain("tag1");
    expect(rebuildFtsIfNeeded(db)).toBeNull();
  });

  test("GC of orphaned vec rows", () => {
    db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)").run(
      9999,
      JSON.stringify([0.1, 0.2, 0.3, 0.4]),
    );
    const report = gcOrphans(db);
    expect(report?.detail).toContain("1 orphaned vector");
    expect(gcOrphans(db)).toBeNull();
  });

  test("content_hash mismatch triggers recompute + re-chunk", () => {
    const doc = createDocument(db, { title: "T", content: "本文", bucket: "main" });
    db.prepare("UPDATE documents SET content_hash = 'broken' WHERE id = ?").run(doc.id);
    const report = fixContentHashes(db);
    expect(report?.detail).toContain("1 document");
    expect(fixContentHashes(db)).toBeNull();
    const row = db.prepare("SELECT updated_at FROM documents WHERE id = ?").get(doc.id) as {
      updated_at: string;
    };
    expect(row.updated_at).toBe(doc.updatedAt);
  });

  test("bulk re-resolution of unresolved links", () => {
    const src = createDocument(db, { title: "元", content: "[[先]]", bucket: "main" });
    const dst = createDocument(db, { title: "先", content: "x", bucket: "main" });
    // Manually reset the link to unresolved
    db.prepare("UPDATE links SET target_id = NULL WHERE source_id = ?").run(src.id);
    const report = resolveAllUnresolvedLinks(db);
    expect(report?.detail).toContain("1 unresolved link");
    const link = db.prepare("SELECT target_id FROM links WHERE source_id = ?").get(src.id) as {
      target_id: number;
    };
    expect(link.target_id).toBe(dst.id);
  });

  test("embedding config change recreates chunks_vec and resets embedded_at", () => {
    createDocument(db, { title: "T", content: "本文", bucket: "main" });
    db.exec("UPDATE chunks SET embedded_at = datetime('now')");
    config.llm.models.embedding = "new-model";
    config.llm.models.embedding_dimensions = 8;
    const report = recreateVecIfModelChanged(db, config);
    expect(report?.action).toBe("vec-recreate");
    // Recreated with 8 dimensions
    db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)").run(
      1,
      JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8]),
    );
    const pending = db
      .prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedded_at IS NULL")
      .get() as { n: number };
    expect(pending.n).toBeGreaterThan(0);
    expect(recreateVecIfModelChanged(db, config)).toBeNull();
  });

  test("retokenizeFts rebuilds FTS and updates meta", () => {
    createDocument(db, { title: "検索対象", content: "全文検索のテキスト", bucket: "main" });
    setMeta(db, "fts_tokenizer", "trigram");
    const report = retokenizeFts(db, "trigram");
    expect(report.action).toBe("fts-retokenize");
    const hits = db
      .prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?")
      .all('"全文検索"');
    expect(hits.length).toBe(1);
  });
});
