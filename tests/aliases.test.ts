import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addAliasesToDoc,
  docAliases,
  removeAliasesFromDoc,
  setAliasesForDoc,
} from "../src/core/aliases";
import { openDatabase } from "../src/core/db";
import {
  createDocument,
  deleteDocument,
  importDocument,
  resolveDoc,
  updateDocument,
} from "../src/core/documents";
import { UsageError } from "../src/core/errors";
import { parseFrontmatter, serializeFrontmatter } from "../src/core/frontmatter";
import { outlinks } from "../src/core/links";
import { keywordSearch } from "../src/core/search/keyword";
import { runCli } from "./helpers";

let db: Database;

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
});

afterEach(() => {
  db.close();
});

function ftsAliases(id: number): string | undefined {
  const row = db.prepare("SELECT aliases FROM documents_fts WHERE rowid = ?").get(id) as {
    aliases: string;
  } | null;
  return row?.aliases;
}

describe("alias CRUD and FTS sync", () => {
  test("addAliasesToDoc syncs the FTS aliases column and keyword search matches", () => {
    const doc = createDocument(db, {
      title: "サーバー構成メモ",
      content: "本番環境の構成手順。",
      bucket: "main",
    });
    const added = addAliasesToDoc(db, doc.id, ["サーバ構成"]);
    expect(added).toEqual(["サーバ構成"]);
    expect(docAliases(db, doc.id)).toEqual(["サーバ構成"]);
    expect(ftsAliases(doc.id)).toBe("サーバ構成");

    // 「サーバ構成」 is not a substring of title or body (長音の有無) — only the alias matches
    const hits = keywordSearch(db, "trigram", "サーバ構成");
    expect(hits.map((h) => h.key)).toEqual([doc.key]);
  });

  test("skips the title and case-insensitive duplicates; rejects invalid aliases", () => {
    const doc = createDocument(db, { title: "DB設計", content: "設計方針。", bucket: "main" });
    expect(addAliasesToDoc(db, doc.id, ["db設計"])).toEqual([]); // == title
    expect(addAliasesToDoc(db, doc.id, ["データベース設計", "データベース設計 "])).toEqual([
      "データベース設計",
    ]);
    expect(addAliasesToDoc(db, doc.id, ["データベース設計"])).toEqual([]);
    for (const bad of ["", "  ", "a|b", "a[b", "a]b", "a/b", "a\nb"]) {
      expect(() => addAliasesToDoc(db, doc.id, [bad])).toThrow(UsageError);
    }
  });

  test("createDocument accepts aliases and returns them on the record", () => {
    const doc = createDocument(db, {
      title: "検索パイプライン",
      content: "RRF とリランク。",
      bucket: "main",
      aliases: ["ハイブリッド検索"],
    });
    expect(doc.aliases).toEqual(["ハイブリッド検索"]);
    expect(ftsAliases(doc.id)).toBe("ハイブリッド検索");
  });

  test("updateDocument aliases are add-only; setAliasesForDoc replaces", () => {
    const doc = createDocument(db, {
      title: "形態素解析",
      content: "vaporetto の話。",
      bucket: "main",
      aliases: ["トークナイザ"],
    });
    const { record } = updateDocument(db, doc.id, { aliases: ["分かち書き"] });
    expect(record.aliases).toEqual(["トークナイザ", "分かち書き"]);

    const result = setAliasesForDoc(db, doc.id, ["分かち書き", "morphology"]);
    expect(result.added).toEqual(["morphology"]);
    expect(result.removed).toBe(1);
    expect(docAliases(db, doc.id)).toEqual(["分かち書き", "morphology"]);
  });

  test("removeAliasesFromDoc is case-insensitive and refreshes FTS", () => {
    const doc = createDocument(db, {
      title: "全文検索メモ",
      content: "FTS5 の設定。",
      bucket: "main",
      aliases: ["インデックス設計"],
    });
    expect(removeAliasesFromDoc(db, doc.id, ["インデックス設計"])).toBe(1);
    expect(ftsAliases(doc.id)).toBe("");
    expect(keywordSearch(db, "trigram", "インデックス設計")).toEqual([]);
  });

  test("deleting a document cascades its aliases", () => {
    const doc = createDocument(db, {
      title: "一時メモ",
      content: "使い捨て。",
      bucket: "main",
      aliases: ["スクラッチ"],
    });
    deleteDocument(db, doc.id);
    const rows = db.prepare("SELECT COUNT(*) AS n FROM document_aliases").get() as { n: number };
    expect(rows.n).toBe(0);
  });
});

describe("wiki-link resolution via aliases", () => {
  test("[[alias]] resolves on save (stage 3)", () => {
    const target = createDocument(db, {
      title: "データベース設計",
      content: "正規化の方針。",
      bucket: "main",
      aliases: ["DB設計"],
    });
    const source = createDocument(db, {
      title: "リンク元",
      content: "[[DB設計]] を参照。",
      bucket: "main",
    });
    expect(outlinks(db, source.id)[0]?.target?.key).toBe(target.key);
  });

  test("adding an alias later self-heals unresolved links; removing re-unresolves them", () => {
    const source = createDocument(db, {
      title: "リンク元",
      content: "[[DB設計]] を参照。",
      bucket: "main",
    });
    expect(outlinks(db, source.id)[0]?.target).toBeNull();

    const target = createDocument(db, {
      title: "データベース設計",
      content: "正規化の方針。",
      bucket: "main",
    });
    addAliasesToDoc(db, target.id, ["DB設計"]);
    expect(outlinks(db, source.id)[0]?.target?.key).toBe(target.key);

    removeAliasesFromDoc(db, target.id, ["db設計"]);
    expect(outlinks(db, source.id)[0]?.target).toBeNull();
  });

  test("a title match wins over an alias match", () => {
    createDocument(db, {
      title: "別ドキュメント",
      content: "こちらは別名側。",
      bucket: "main",
      aliases: ["DB設計"],
    });
    const titled = createDocument(db, { title: "DB設計", content: "本命。", bucket: "main" });
    const source = createDocument(db, {
      title: "リンク元",
      content: "[[DB設計]] を参照。",
      bucket: "main",
    });
    expect(outlinks(db, source.id)[0]?.target?.key).toBe(titled.key);
  });

  test("an alias shared by two documents stays unresolved", () => {
    createDocument(db, { title: "文書A", content: "x", bucket: "main", aliases: ["共通別名"] });
    createDocument(db, { title: "文書B", content: "y", bucket: "main", aliases: ["共通別名"] });
    const source = createDocument(db, {
      title: "リンク元",
      content: "[[共通別名]] を参照。",
      bucket: "main",
    });
    expect(outlinks(db, source.id)[0]?.target).toBeNull();
  });
});

describe("resolveDoc via aliases", () => {
  test("resolves a unique alias after the title stage", () => {
    const doc = createDocument(db, {
      title: "ナレッジベース運用",
      content: "運用手順。",
      bucket: "main",
      aliases: ["KB運用"],
    });
    expect(resolveDoc(db, "KB運用").key).toBe(doc.key);
  });

  test("an ambiguous alias throws ConflictError; unknown alias throws NotFoundError", () => {
    createDocument(db, { title: "文書A", content: "x", bucket: "main", aliases: ["共通別名"] });
    createDocument(db, { title: "文書B", content: "y", bucket: "main", aliases: ["共通別名"] });
    expect(() => resolveDoc(db, "共通別名")).toThrow(/ambiguous/);
    expect(() => resolveDoc(db, "存在しない別名")).toThrow(/not found/);
  });
});

describe("frontmatter round-trip", () => {
  test("serialize emits aliases only when present; parse drops invalid entries", () => {
    const fm = serializeFrontmatter({
      kura_key: "aaaa1111",
      title: "検索設計",
      bucket: "main",
      path: "",
      tags: [],
      aliases: ["FTS設計", "全文検索設計"],
      created_at: "2026-07-01 00:00:00",
      updated_at: "2026-07-01 00:00:00",
    });
    expect(fm).toContain('aliases: ["FTS設計", "全文検索設計"]');

    const parsed = parseFrontmatter(`---
title: "検索設計"
aliases: ["FTS設計", "a|b", "fts設計", ""]
---
本文。
`);
    expect(parsed.fm?.aliases).toEqual(["FTS設計"]);
  });

  test("importDocument applies aliases on create and update", () => {
    const created = importDocument(db, {
      fm: { title: "検索設計", aliases: ["FTS設計"] },
      body: "本文。",
      fallbackTitle: "検索設計",
      defaultBucket: "main",
    });
    expect(created.action).toBe("created");
    expect(created.record.aliases).toEqual(["FTS設計"]);

    const updated = importDocument(db, {
      fm: { kura_key: created.record.key, title: "検索設計", aliases: ["全文検索設計"] },
      body: "改訂した本文。",
      fallbackTitle: "検索設計",
      defaultBucket: "main",
    });
    expect(updated.action).toBe("updated");
    expect(updated.record.aliases).toEqual(["FTS設計", "全文検索設計"]);
  });
});

describe("kura alias CLI", () => {
  test("alias add / ls / rm and get-by-alias", async () => {
    const home = mkdtempSync(join(tmpdir(), "kura-alias-cli-"));
    const env = { KURA_HOME: home, KURA_DB: join(home, "kura.db") };
    try {
      const init = await runCli(["init", "--no-download"], env);
      expect(init.code).toBe(0);

      const cliDb = openDatabase({ path: env.KURA_DB, vaporettoPath: null }).db;
      createDocument(cliDb, { title: "データベース設計", content: "方針。", bucket: "main" });
      cliDb.close();

      const add = await runCli(["alias", "add", "データベース設計", "DB設計"], env);
      expect(add.code).toBe(0);
      expect(add.stdout).toContain("added 1 alias(es)");

      const ls = await runCli(["alias", "ls", "データベース設計", "--json"], env);
      expect(ls.code).toBe(0);
      expect(JSON.parse(ls.stdout).aliases).toEqual(["DB設計"]);

      const get = await runCli(["get", "DB設計", "--json"], env);
      expect(get.code).toBe(0);
      const doc = JSON.parse(get.stdout);
      expect(doc.title).toBe("データベース設計");
      expect(doc.aliases).toEqual(["DB設計"]);

      const rm = await runCli(["alias", "rm", "データベース設計", "DB設計"], env);
      expect(rm.code).toBe(0);
      const gone = await runCli(["get", "DB設計"], env);
      expect(gone.code).toBe(3);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
