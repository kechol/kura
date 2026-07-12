import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBucket } from "../src/core/buckets";
import { openDatabase } from "../src/core/db";
import { resolveAllUnresolvedLinks } from "../src/core/doctor";
import {
  buildDocTree,
  createDocument,
  createDocumentWithRetry,
  docTree,
  getDocumentByKey,
  importDocument,
  listDocuments,
  moveDocument,
  moveDocumentsByPrefix,
  resolveDoc,
  updateDocument,
} from "../src/core/documents";
import { brokenLinks, outlinks } from "../src/core/links";
import { joinDocPath, normalizeDocPath, replaceWikiLinkTargets } from "../src/core/wiki";

let db: Database;

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
});

afterEach(() => {
  db.close();
});

describe("normalizeDocPath / joinDocPath", () => {
  test("trims segments, collapses slashes, preserves case", () => {
    expect(normalizeDocPath("")).toBe("");
    expect(normalizeDocPath("/db//sqlite/")).toBe("db/sqlite");
    expect(normalizeDocPath(" クリップ / 技術 ")).toBe("クリップ/技術");
    expect(normalizeDocPath("Clips")).toBe("Clips");
  });

  test("joinDocPath treats '' as the bucket root", () => {
    expect(joinDocPath("", "メモ")).toBe("メモ");
    expect(joinDocPath("db/sqlite", "メモ")).toBe("db/sqlite/メモ");
  });
});

describe("replaceWikiLinkTargets", () => {
  test("rewrites several spellings in one pass, preserving display and code", () => {
    const content = [
      "[[旧タイトル]] と [[db/旧タイトル|表示名]] を参照。",
      "```",
      "[[旧タイトル]] はコード内なのでそのまま",
      "```",
    ].join("\n");
    const out = replaceWikiLinkTargets(content, [
      { from: "旧タイトル", to: "新タイトル" },
      { from: "db/旧タイトル", to: "db2/新タイトル" },
    ]);
    expect(out).toContain("[[新タイトル]]");
    expect(out).toContain("[[db2/新タイトル|表示名]]");
    expect(out).toContain("[[旧タイトル]] はコード内なのでそのまま");
  });
});

describe("path uniqueness (docs: data-model.md)", () => {
  test("equal titles may coexist on different paths, not on the same one", () => {
    createDocument(db, { title: "メモ", content: "1", bucket: "main" });
    expect(() =>
      createDocument(db, { title: "メモ", content: "2", bucket: "main", path: "db/sqlite" }),
    ).not.toThrow();
    expect(() =>
      createDocument(db, { title: "メモ", content: "3", bucket: "main", path: "db/sqlite" }),
    ).toThrow(/already exists/);
  });

  test("uniqueness is case-insensitive across path and title", () => {
    createDocument(db, { title: "メモ", content: "1", bucket: "main", path: "Clips" });
    expect(() =>
      createDocument(db, { title: "メモ", content: "2", bucket: "main", path: "clips" }),
    ).toThrow(/already exists/);
  });

  test("rejects cross-form full-path collisions (path='a',title='b/c' vs path='a/b',title='c')", () => {
    createDocument(db, { title: "b/c", content: "1", bucket: "main", path: "a" });
    expect(() =>
      createDocument(db, { title: "c", content: "2", bucket: "main", path: "a/b" }),
    ).toThrow(/collides/);
  });
});

describe("two-stage wiki-link resolution (docs: document-notation.md)", () => {
  test("[[full/path/Title]] resolves by computed full path", () => {
    const target = createDocument(db, {
      title: "メモ",
      content: "本文",
      bucket: "main",
      path: "db/sqlite",
    });
    const src = createDocument(db, { title: "元", content: "[[db/sqlite/メモ]]", bucket: "main" });
    expect(outlinks(db, src.id)[0]?.target?.key).toBe(target.key);
  });

  test("[[Title]] resolves only when exactly one document has the title", () => {
    const target = createDocument(db, {
      title: "設計方針",
      content: "本文",
      bucket: "main",
      path: "検索",
    });
    const src = createDocument(db, { title: "元", content: "[[設計方針]]", bucket: "main" });
    expect(outlinks(db, src.id)[0]?.target?.key).toBe(target.key);

    // A second 設計方針 appears — new short-form references become ambiguous
    createDocument(db, { title: "設計方針", content: "本文", bucket: "main", path: "UI" });
    const src2 = createDocument(db, { title: "元2", content: "[[設計方針]]", bucket: "main" });
    expect(outlinks(db, src2.id)[0]?.target).toBeNull();
    expect(brokenLinks(db).map((b) => b.targetTitle)).toContain("設計方針");
  });

  test("already-resolved links are sticky when a same-title document appears later", () => {
    const target = createDocument(db, {
      title: "設計方針",
      content: "本文",
      bucket: "main",
      path: "検索",
    });
    const src = createDocument(db, { title: "元", content: "[[設計方針]]", bucket: "main" });
    createDocument(db, { title: "設計方針", content: "本文", bucket: "main", path: "UI" });
    expect(outlinks(db, src.id)[0]?.target?.key).toBe(target.key);
  });

  test("an unresolved full-path link auto-resolves when the document is created later", () => {
    const src = createDocument(db, {
      title: "元",
      content: "[[clips/未来の記事]]",
      bucket: "main",
    });
    expect(outlinks(db, src.id)[0]?.target).toBeNull();
    const target = createDocument(db, {
      title: "未来の記事",
      content: "本文",
      bucket: "main",
      path: "clips",
    });
    expect(outlinks(db, src.id)[0]?.target?.key).toBe(target.key);
  });

  test("doctor bulk resolution follows the same rules (ambiguous stays unresolved)", () => {
    const srcUnique = createDocument(db, { title: "元1", content: "[[一意なページ]]", bucket: "main" });
    const srcAmbiguous = createDocument(db, { title: "元2", content: "[[重複ページ]]", bucket: "main" });
    const unique = createDocument(db, {
      title: "一意なページ",
      content: "x",
      bucket: "main",
      path: "docs",
    });
    createDocument(db, { title: "重複ページ", content: "x", bucket: "main", path: "a" });
    createDocument(db, { title: "重複ページ", content: "x", bucket: "main", path: "b" });
    // Force both back to unresolved, then let doctor re-resolve in bulk
    db.prepare("UPDATE links SET target_id = NULL").run();
    resolveAllUnresolvedLinks(db);
    expect(outlinks(db, srcUnique.id)[0]?.target?.key).toBe(unique.key);
    expect(outlinks(db, srcAmbiguous.id)[0]?.target).toBeNull();
  });
});

describe("resolveDoc with paths (docs: cli-reference.md)", () => {
  test("resolves by full path, and reports same-bucket title ambiguity with paths", () => {
    const a = createDocument(db, { title: "メモ", content: "1", bucket: "main", path: "db" });
    createDocument(db, { title: "メモ", content: "2", bucket: "main", path: "ml" });
    expect(resolveDoc(db, "db/メモ").key).toBe(a.key);
    expect(() => resolveDoc(db, "メモ")).toThrow(/ambiguous.*db\/.*ml\//s);
    expect(() => resolveDoc(db, "メモ", "main")).toThrow(/full path/);
  });

  test("a full path that collides across buckets asks for a bucket", () => {
    createBucket(db, "work");
    createDocument(db, { title: "メモ", content: "1", bucket: "main", path: "db" });
    const w = createDocument(db, { title: "メモ", content: "2", bucket: "work", path: "db" });
    expect(() => resolveDoc(db, "db/メモ")).toThrow(/ambiguous across buckets/);
    expect(resolveDoc(db, "db/メモ", "work").key).toBe(w.key);
  });
});

describe("rename / move link rewriting (docs: document-notation.md)", () => {
  test("a title change rewrites both the short and full-path spellings", () => {
    const target = createDocument(db, {
      title: "旧タイトル",
      content: "本文",
      bucket: "main",
      path: "db",
    });
    const src = createDocument(db, {
      title: "元",
      content: "[[旧タイトル]] と [[db/旧タイトル]] を参照。",
      bucket: "main",
    });
    updateDocument(db, target.id, { title: "新タイトル" });
    const rewritten = getDocumentByKey(db, src.key)?.content ?? "";
    expect(rewritten).toContain("[[新タイトル]]");
    expect(rewritten).toContain("[[db/新タイトル]]");
    expect(outlinks(db, src.id).every((l) => l.target?.key === target.key)).toBe(true);
  });

  test("a rename onto an ambiguous title points short links at the full path", () => {
    createDocument(db, { title: "メモ", content: "x", bucket: "main", path: "ml" });
    const target = createDocument(db, {
      title: "旧タイトル",
      content: "本文",
      bucket: "main",
      path: "db",
    });
    const src = createDocument(db, { title: "元", content: "[[旧タイトル]]", bucket: "main" });
    updateDocument(db, target.id, { title: "メモ" });
    const rewritten = getDocumentByKey(db, src.key)?.content ?? "";
    expect(rewritten).toContain("[[db/メモ]]");
    expect(outlinks(db, src.id)[0]?.target?.key).toBe(target.key);
  });

  test("a path-only move rewrites full-path links and leaves short links resolved", () => {
    const target = createDocument(db, {
      title: "設計方針",
      content: "本文",
      bucket: "main",
      path: "旧置き場",
    });
    const src = createDocument(db, {
      title: "元",
      content: "[[設計方針]] と [[旧置き場/設計方針]] を参照。",
      bucket: "main",
    });
    const { record } = moveDocument(db, target.id, "新置き場/検索");
    expect(record.path).toBe("新置き場/検索");
    const rewritten = getDocumentByKey(db, src.key)?.content ?? "";
    expect(rewritten).toContain("[[設計方針]]");
    expect(rewritten).toContain("[[新置き場/検索/設計方針]]");
    expect(outlinks(db, src.id).every((l) => l.target?.key === target.key)).toBe(true);
  });
});

describe("moveDocumentsByPrefix (kura mv --prefix)", () => {
  test("moves the whole subtree and reports each document", () => {
    createDocument(db, { title: "メモ", content: "x", bucket: "main", path: "db/sqlite" });
    createDocument(db, { title: "WAL", content: "x", bucket: "main", path: "db/sqlite/内部" });
    createDocument(db, { title: "無関係", content: "x", bucket: "main", path: "web" });
    const bucketId = (db.prepare("SELECT id FROM buckets WHERE name = 'main'").get() as { id: number }).id;
    const { moved } = moveDocumentsByPrefix(db, bucketId, "db/sqlite", "database/sqlite3");
    expect(moved.map((m) => m.to).sort()).toEqual([
      "database/sqlite3/メモ",
      "database/sqlite3/内部/WAL",
    ]);
    expect(listDocuments(db, { prefix: "web" }).length).toBe(1);
  });

  test("a destination conflict rolls back the whole move", () => {
    createDocument(db, { title: "メモ", content: "x", bucket: "main", path: "旧" });
    createDocument(db, { title: "メモ", content: "y", bucket: "main", path: "新" });
    const bucketId = (db.prepare("SELECT id FROM buckets WHERE name = 'main'").get() as { id: number }).id;
    expect(() => moveDocumentsByPrefix(db, bucketId, "旧", "新")).toThrow(/already exists/);
    expect(listDocuments(db, { prefix: "旧" }).length).toBe(1);
  });

  test("guards against moving under a descendant and unknown prefixes", () => {
    createDocument(db, { title: "メモ", content: "x", bucket: "main", path: "a" });
    const bucketId = (db.prepare("SELECT id FROM buckets WHERE name = 'main'").get() as { id: number }).id;
    expect(() => moveDocumentsByPrefix(db, bucketId, "a", "a/b")).toThrow(/descendant/);
    expect(() => moveDocumentsByPrefix(db, bucketId, "存在しない", "x")).toThrow(/no documents/);
  });
});

describe("createDocumentWithRetry (kura clip collisions)", () => {
  test("retries with 'タイトル (2)', 'タイトル (3)', ...", () => {
    const input = { title: "HTTP/3とQUICの現在", content: "x", bucket: "main", path: "clips" };
    expect(createDocumentWithRetry(db, input).title).toBe("HTTP/3とQUICの現在");
    expect(createDocumentWithRetry(db, input).title).toBe("HTTP/3とQUICの現在 (2)");
    expect(createDocumentWithRetry(db, input).title).toBe("HTTP/3とQUICの現在 (3)");
  });
});

describe("listDocuments prefix filter", () => {
  test("includes descendants, excludes unrelated paths", () => {
    createDocument(db, { title: "a", content: "x", bucket: "main", path: "db" });
    createDocument(db, { title: "b", content: "x", bucket: "main", path: "db/sqlite" });
    createDocument(db, { title: "c", content: "x", bucket: "main", path: "web" });
    createDocument(db, { title: "d", content: "x", bucket: "main" });
    expect(listDocuments(db, { prefix: "db" }).length).toBe(2);
    expect(listDocuments(db, { prefix: "db/sqlite" }).length).toBe(1);
    expect(listDocuments(db, { prefix: "なし" }).length).toBe(0);
  });
});

describe("buildDocTree / docTree (docs: browser-ui.md)", () => {
  test("builds branches from paths and leaves from documents, folders first", () => {
    createDocument(db, { title: "メモ", content: "x", bucket: "main", path: "db/sqlite" });
    createDocument(db, { title: "WAL", content: "x", bucket: "main", path: "db/sqlite" });
    createDocument(db, { title: "ルート直下", content: "x", bucket: "main" });
    const tree = docTree(db, "main");

    expect(tree.map((n) => n.segment)).toEqual(["db", "ルート直下"]);
    const dbNode = tree[0]!;
    expect(dbNode.key).toBeUndefined();
    expect(dbNode.total).toBe(2);
    const sqlite = dbNode.children[0]!;
    expect(sqlite.segment).toBe("sqlite");
    expect(sqlite.children.map((n) => n.segment)).toEqual(["WAL", "メモ"]);
    expect(sqlite.children.every((n) => n.key !== undefined)).toBe(true);
  });

  test("a document whose full path is also a path prefix merges into the branch", () => {
    const parent = createDocument(db, { title: "sqlite", content: "x", bucket: "main", path: "db" });
    createDocument(db, { title: "メモ", content: "x", bucket: "main", path: "db/sqlite" });
    const tree = docTree(db, "main");
    const sqlite = tree[0]!.children[0]!;
    expect(sqlite.segment).toBe("sqlite");
    expect(sqlite.key).toBe(parent.key);
    expect(sqlite.children.map((n) => n.segment)).toEqual(["メモ"]);
    expect(sqlite.total).toBe(2);
  });

  test("a literal '/' in a title does not create hierarchy", () => {
    const entries = [{ key: "aaaa1111", path: "", title: "HTTP/3とQUICの現在" }];
    const tree = buildDocTree(entries);
    expect(tree.length).toBe(1);
    expect(tree[0]?.segment).toBe("HTTP/3とQUICの現在");
    expect(tree[0]?.children).toEqual([]);
  });
});

describe("importDocument path fallback", () => {
  test("frontmatter path wins; the on-disk dir is the fallback with the bucket segment stripped", () => {
    const viaFm = importDocument(db, {
      fm: { title: "記事A", path: "クリップ/技術" },
      body: "本文",
      fallbackTitle: "記事A",
      fallbackPath: "main/どこか",
      defaultBucket: "main",
    });
    expect(viaFm.record.path).toBe("クリップ/技術");

    const viaDir = importDocument(db, {
      fm: null,
      body: "本文",
      fallbackTitle: "記事B",
      fallbackPath: "main/クリップ/技術",
      defaultBucket: "main",
    });
    expect(viaDir.record.path).toBe("クリップ/技術");
  });
});
