import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBucket, deleteBucket, listBuckets, renameBucket } from "../src/core/buckets";
import { openDatabase } from "../src/core/db";
import {
  createDocument,
  deleteDocument,
  getDocumentByKey,
  importDocument,
  listDocuments,
  renameDocument,
  resolveDoc,
  touchAccess,
  updateDocument,
} from "../src/core/documents";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter";
import { backlinks, brokenLinks, outlinks, twoHopLinks } from "../src/core/links";
import { buildTagTree, gcTags, listTags, removeTagsFromDoc, renameTag } from "../src/core/tags";

let db: Database;

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
});

afterEach(() => {
  db.close();
});

function ftsRow(id: number): { title: string; tags: string } | null {
  return db.prepare("SELECT title, tags FROM documents_fts WHERE rowid = ?").get(id) as {
    title: string;
    tags: string;
  } | null;
}

describe("createDocument", () => {
  test("本文からタグ・リンクを抽出し FTS/chunks を同期する", () => {
    const doc = createDocument(db, {
      title: "SQLite の WAL モード",
      content:
        "#tech/db/sqlite の話。[[トランザクション設計]] も参照。\n\nWAL は書き込みをブロックしない。",
      bucket: "main",
      tags: ["メモ"],
    });

    expect(doc.key).toMatch(/^[0-9a-f]{8}$/);
    expect(doc.tags).toEqual(["tech/db/sqlite", "メモ"].sort());

    const fts = ftsRow(doc.id);
    expect(fts?.title).toBe("SQLite の WAL モード");
    expect(fts?.tags).toContain("tech/db/sqlite");

    const links = outlinks(db, doc.id);
    expect(links.length).toBe(1);
    expect(links[0]?.targetTitle).toBe("トランザクション設計");
    expect(links[0]?.target).toBeNull();

    const chunks = db
      .prepare("SELECT text, embedded_at FROM chunks WHERE document_id = ?")
      .all(doc.id) as Array<{ text: string; embedded_at: string | null }>;
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.text).toContain("# SQLite の WAL モード");
    expect(chunks[0]?.embedded_at).toBeNull();

    // FTS 検索可能（trigram: 3文字以上）
    const hit = db
      .prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?")
      .all('"トランザクション"');
    expect(hit.length).toBe(1);
  });

  test("先にリンクを書いた後からページを作ると自動解決される（SPEC §10.1）", () => {
    const a = createDocument(db, {
      title: "リンク元",
      content: "[[未来のページ]] を参照",
      bucket: "main",
    });
    expect(outlinks(db, a.id)[0]?.target).toBeNull();

    const b = createDocument(db, {
      title: "未来のページ",
      content: "本文",
      bucket: "main",
    });
    const resolved = outlinks(db, a.id);
    expect(resolved[0]?.target?.key).toBe(b.key);
    expect(backlinks(db, b.id).map((d) => d.key)).toEqual([a.key]);
  });

  test("大文字小文字を無視してリンク解決する", () => {
    createDocument(db, { title: "Bun Runtime", content: "本文", bucket: "main" });
    const src = createDocument(db, { title: "メモ", content: "[[bun runtime]]", bucket: "main" });
    expect(outlinks(db, src.id)[0]?.target).not.toBeNull();
  });

  test("同一 Bucket 内のタイトル重複は拒否、別 Bucket は許可", () => {
    createBucket(db, "work");
    createDocument(db, { title: "重複", content: "1", bucket: "main" });
    expect(() => createDocument(db, { title: "重複", content: "2", bucket: "main" })).toThrow(
      /already exists/,
    );
    expect(() => createDocument(db, { title: "重複", content: "3", bucket: "work" })).not.toThrow();
  });

  test("リンク解決は Bucket を跨がない", () => {
    createBucket(db, "work");
    createDocument(db, { title: "対象", content: "本文", bucket: "work" });
    const src = createDocument(db, { title: "元", content: "[[対象]]", bucket: "main" });
    expect(outlinks(db, src.id)[0]?.target).toBeNull();
  });
});

describe("updateDocument", () => {
  test("本文変更時のみチャンク再構築（embedded_at リセット）", () => {
    const doc = createDocument(db, { title: "T", content: "最初の本文", bucket: "main" });
    db.prepare("UPDATE chunks SET embedded_at = datetime('now') WHERE document_id = ?").run(doc.id);

    // 本文以外の更新はチャンクを保持
    updateDocument(db, doc.id, { sourceUrl: "https://example.com" });
    const kept = db
      .prepare("SELECT embedded_at FROM chunks WHERE document_id = ?")
      .all(doc.id) as Array<{ embedded_at: string | null }>;
    expect(kept.every((c) => c.embedded_at !== null)).toBe(true);

    // 本文変更で再構築
    updateDocument(db, doc.id, { content: "書き換えた本文" });
    const rebuilt = db
      .prepare("SELECT text, embedded_at FROM chunks WHERE document_id = ?")
      .all(doc.id) as Array<{ text: string; embedded_at: string | null }>;
    expect(rebuilt.every((c) => c.embedded_at === null)).toBe(true);
    expect(rebuilt[0]?.text).toContain("書き換えた本文");
  });
});

describe("renameDocument (kura mv)", () => {
  test("被リンク元の [[旧タイトル]] を書き換えて解決を維持する", () => {
    const target = createDocument(db, { title: "旧タイトル", content: "本文", bucket: "main" });
    const ref = createDocument(db, {
      title: "参照元",
      content:
        "詳細は [[旧タイトル]] と [[旧タイトル|表示名]] を参照。\n```\n[[旧タイトル]] はコード内なので残る\n```",
      bucket: "main",
    });

    const { relinked } = renameDocument(db, target.id, "新タイトル");
    expect(relinked).toBe(1);

    const refDoc = getDocumentByKey(db, ref.key)!;
    expect(refDoc.content).toContain("[[新タイトル]]");
    expect(refDoc.content).toContain("[[新タイトル|表示名]]");
    expect(refDoc.content).toContain("```\n[[旧タイトル]] はコード内なので残る");

    const links = outlinks(db, ref.id);
    expect(links.length).toBe(1);
    expect(links[0]?.targetTitle).toBe("新タイトル");
    expect(links[0]?.target?.key).toBe(target.key);

    // FTS のタイトルも更新される
    expect(ftsRow(target.id)?.title).toBe("新タイトル");
  });

  test("リネーム先タイトルへの既存未解決リンクも解決する", () => {
    const src = createDocument(db, { title: "元", content: "[[将来の名前]]", bucket: "main" });
    const doc = createDocument(db, { title: "いまの名前", content: "x", bucket: "main" });
    renameDocument(db, doc.id, "将来の名前");
    expect(outlinks(db, src.id)[0]?.target?.key).toBe(doc.key);
  });
});

describe("deleteDocument", () => {
  test("FTS/chunks/vec を掃除し、被リンクは未解決に戻る", () => {
    const target = createDocument(db, { title: "消える", content: "本文", bucket: "main" });
    const src = createDocument(db, { title: "残る", content: "[[消える]]", bucket: "main" });
    expect(outlinks(db, src.id)[0]?.target).not.toBeNull();

    deleteDocument(db, target.id);
    expect(ftsRow(target.id)).toBeNull();
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE document_id = ?").get(target.id),
    ).toEqual({ n: 0 });
    const links = outlinks(db, src.id);
    expect(links[0]?.target).toBeNull();
    expect(brokenLinks(db)[0]?.targetTitle).toBe("消える");
  });
});

describe("resolveDoc", () => {
  test("doc_key / #key / タイトルで解決し、曖昧なら例外", () => {
    createBucket(db, "work");
    const a = createDocument(db, { title: "ノート", content: "a", bucket: "main" });
    createDocument(db, { title: "ノート", content: "b", bucket: "work" });

    expect(resolveDoc(db, a.key).id).toBe(a.id);
    expect(resolveDoc(db, `#${a.key}`).id).toBe(a.id);
    expect(resolveDoc(db, "ノート", "main").id).toBe(a.id);
    expect(() => resolveDoc(db, "ノート")).toThrow(/ambiguous/);
    expect(() => resolveDoc(db, "存在しない")).toThrow(/not found/);
  });

  test("touchAccess が参照情報を更新する", () => {
    const doc = createDocument(db, { title: "T", content: "c", bucket: "main" });
    touchAccess(db, doc.id);
    touchAccess(db, doc.id);
    const row = db
      .prepare("SELECT access_count, last_accessed_at FROM documents WHERE id = ?")
      .get(doc.id) as { access_count: number; last_accessed_at: string | null };
    expect(row.access_count).toBe(2);
    expect(row.last_accessed_at).not.toBeNull();
  });
});

describe("listDocuments", () => {
  test("bucket / tag（子孫含む）/ limit でフィルタする", () => {
    createBucket(db, "work");
    createDocument(db, { title: "A", content: "#tech/db", bucket: "main" });
    createDocument(db, { title: "B", content: "#tech/db/sqlite", bucket: "main" });
    createDocument(db, { title: "C", content: "#life", bucket: "work" });

    expect(listDocuments(db, { bucket: "work" }).map((d) => d.title)).toEqual(["C"]);
    expect(
      listDocuments(db, { tag: "tech/db" })
        .map((d) => d.title)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(listDocuments(db, { tag: "tech" }).length).toBe(2);
    expect(listDocuments(db, { limit: 2 }).length).toBe(2);
  });
});

describe("import / export round-trip", () => {
  test("kura_key ありは更新、なしは新規", () => {
    const doc = createDocument(db, {
      title: "元タイトル",
      content: "元本文 #tag1",
      bucket: "main",
    });

    // export 相当
    const fmText = serializeFrontmatter({
      kura_key: doc.key,
      title: "変更後タイトル",
      bucket: "main",
      tags: ["tag1", "tag2"],
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    const { fm, body } = parseFrontmatter(`${fmText}\n変更後本文`);
    expect(fm?.kura_key).toBe(doc.key);

    const updated = importDocument(db, {
      fm,
      body,
      fallbackTitle: "x",
      defaultBucket: "main",
    });
    expect(updated.action).toBe("updated");
    expect(updated.record.id).toBe(doc.id);
    expect(updated.record.title).toBe("変更後タイトル");
    expect(updated.record.tags).toContain("tag2");

    const created = importDocument(db, {
      fm: { title: "新規ドキュメント", bucket: "new-bucket", tags: ["x/y"] },
      body: "新規本文",
      fallbackTitle: "fallback",
      defaultBucket: "main",
    });
    expect(created.action).toBe("created");
    expect(created.record.bucket).toBe("new-bucket");
  });
});

describe("tags", () => {
  test("renameTag は子孫ごと移動し、既存タグへは merge する", () => {
    const a = createDocument(db, {
      title: "A",
      content: "#tech/db #tech/db/sqlite",
      bucket: "main",
    });
    createDocument(db, { title: "B", content: "#dev/db", bucket: "main" });

    const result = renameTag(db, "tech/db", "dev/db");
    expect(result.merged).toBe(true);
    expect(result.moved.sort()).toEqual(["tech/db", "tech/db/sqlite"]);

    const paths = listTags(db).map((t) => t.path);
    expect(paths).toContain("dev/db");
    expect(paths).toContain("dev/db/sqlite");
    expect(paths).not.toContain("tech/db");

    // FTS の tags 列も更新済み
    expect(ftsRow(a.id)?.tags).toContain("dev/db/sqlite");
  });

  test("removeTagsFromDoc / gcTags", () => {
    const doc = createDocument(db, { title: "A", content: "#solo", bucket: "main" });
    removeTagsFromDoc(db, doc.id, ["solo"]);
    expect(ftsRow(doc.id)?.tags ?? "").not.toContain("solo");
    expect(gcTags(db)).toEqual(["solo"]);
    expect(listTags(db).length).toBe(0);
  });

  test("buildTagTree が階層と件数を集計する", () => {
    createDocument(db, { title: "A", content: "#tech/db/sqlite #tech/perf", bucket: "main" });
    createDocument(db, { title: "B", content: "#tech/db", bucket: "main" });
    const tree = buildTagTree(listTags(db));
    const tech = tree.find((n) => n.segment === "tech")!;
    expect(tech.total).toBe(3);
    const dbNode = tech.children.find((n) => n.segment === "db")!;
    expect(dbNode.count).toBe(1);
    expect(dbNode.total).toBe(2);
  });
});

describe("links 2-hop", () => {
  test("共通リンク先を持つ文書をグループ化する", () => {
    createDocument(db, { title: "共通先", content: "hub", bucket: "main" });
    const a = createDocument(db, { title: "A", content: "[[共通先]]", bucket: "main" });
    const b = createDocument(db, { title: "B", content: "[[共通先]]", bucket: "main" });
    createDocument(db, { title: "C", content: "[[A]]", bucket: "main" });

    const groups = twoHopLinks(db, a.id);
    expect(groups.length).toBe(1);
    expect(groups[0]?.via.title).toBe("共通先");
    expect(groups[0]?.docs.map((d) => d.title)).toEqual([b.title]);
  });
});

describe("buckets", () => {
  test("不正な名前を拒否し、非空 Bucket は削除できない", () => {
    expect(() => createBucket(db, "Invalid_Name")).toThrow();
    createBucket(db, "work", "仕事用");
    createDocument(db, { title: "A", content: "x", bucket: "work" });
    expect(() => deleteBucket(db, "work")).toThrow(/not empty/);
    renameBucket(db, "work", "biz");
    expect(
      listBuckets(db)
        .map((b) => b.name)
        .sort(),
    ).toEqual(["biz", "main"]);
  });
});
