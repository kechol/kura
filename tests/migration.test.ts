import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { vecLoadablePath } from "../src/core/bootstrap";
import { migrate, schemaVersion, setupSqlite } from "../src/core/db";

const CTX = { tokenizer: "trigram" as const, dimensions: 4 };

/** Raw connection (openDatabase always migrates to the latest version) */
function openRaw(): Database {
  setupSqlite();
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.loadExtension(vecLoadablePath());
  return db;
}

describe("migration 002: document paths (docs: data-model.md)", () => {
  test("v1 → v2 rebuild preserves ids, links, tags, chunks, and FTS rows", () => {
    const db = openRaw();
    migrate(db, CTX, 1);
    expect(schemaVersion(db)).toBe(1);

    // Seed a v1 dataset with raw SQL (the current core cannot write a v1 schema)
    db.exec("INSERT INTO buckets (name) VALUES ('work')");
    db.exec(`INSERT INTO documents (id, doc_key, bucket_id, title, content, content_hash) VALUES
      (1, 'aaaa1111', 1, '検索設計', '全文検索の設計方針。', 'h1'),
      (2, 'bbbb2222', 1, '形態素解析', '[[検索設計]] と [[未作成ページ]] を参照。', 'h2'),
      (3, 'cccc3333', 2, '会議 議事録', '検索改善の議事録。', 'h3')`);
    db.exec(`INSERT INTO links (source_id, target_id, target_title) VALUES
      (2, 1, '検索設計'), (2, NULL, '未作成ページ')`);
    db.exec("INSERT INTO tags (id, path) VALUES (1, 'tech/db')");
    db.exec("INSERT INTO document_tags (document_id, tag_id) VALUES (1, 1)");
    db.exec(
      "INSERT INTO chunks (document_id, seq, text, start_offset) VALUES (1, 0, '# 検索設計', 0)",
    );
    db.exec(
      "INSERT INTO documents_fts (rowid, title, content, tags) VALUES (1, '検索設計', '全文検索の設計方針。', 'tech/db')",
    );

    migrate(db, CTX, 2);
    expect(schemaVersion(db)).toBe(2);

    // ids / doc_keys unchanged; every row lands at the bucket root
    const docs = db
      .prepare("SELECT id, doc_key, path, title FROM documents ORDER BY id")
      .all() as Array<{ id: number; doc_key: string; path: string; title: string }>;
    expect(docs.map((d) => [d.id, d.doc_key, d.path])).toEqual([
      [1, "aaaa1111", ""],
      [2, "bbbb2222", ""],
      [3, "cccc3333", ""],
    ]);

    // Derived tables were not wiped by the rebuild
    const links = db
      .prepare("SELECT source_id, target_id, target_title FROM links ORDER BY id")
      .all() as Array<{ source_id: number; target_id: number | null; target_title: string }>;
    expect(links).toEqual([
      { source_id: 2, target_id: 1, target_title: "検索設計" },
      { source_id: 2, target_id: null, target_title: "未作成ページ" },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM document_tags").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM documents_fts").get()).toEqual({ n: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // The v1 indexes were recreated on the rebuilt table
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toContain("idx_documents_bucket");
    expect(indexes).toContain("idx_documents_updated");
    db.close();
  });

  test("the rebuilt constraint allows equal titles on different paths only", () => {
    const db = openRaw();
    migrate(db, CTX);
    db.exec(`INSERT INTO documents (doc_key, bucket_id, path, title, content, content_hash)
      VALUES ('aaaa1111', 1, '', 'メモ', 'x', 'h1')`);
    // Same title on another path is now allowed
    db.exec(`INSERT INTO documents (doc_key, bucket_id, path, title, content, content_hash)
      VALUES ('bbbb2222', 1, 'db/sqlite', 'メモ', 'x', 'h2')`);
    // Same (bucket, path, title) is still rejected
    expect(() =>
      db.exec(`INSERT INTO documents (doc_key, bucket_id, path, title, content, content_hash)
        VALUES ('cccc3333', 1, '', 'メモ', 'x', 'h3')`),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});

describe("migration 003: favorites (docs: data-model.md)", () => {
  test("v2 → v3 adds favorite, defaulting existing documents to unpinned", () => {
    const db = openRaw();
    migrate(db, CTX, 2);
    db.exec(`INSERT INTO documents (id, doc_key, bucket_id, path, title, content, content_hash)
      VALUES (1, 'aaaa1111', 1, 'db/sqlite', 'WAL モード', 'ログ先行書き込み。', 'h1')`);

    migrate(db, CTX, 3);
    expect(schemaVersion(db)).toBe(3);

    const row = db.prepare("SELECT favorite FROM documents WHERE id = 1").get();
    expect(row).toEqual({ favorite: 0 });

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'documents'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(indexes).toContain("idx_documents_favorite");
    db.close();
  });
});

describe("migration 004: document aliases (docs: data-model.md)", () => {
  test("v3 → v4 recreates FTS with the aliases column and repopulates rows", () => {
    const db = openRaw();
    migrate(db, CTX, 3);
    db.exec(`INSERT INTO documents (id, doc_key, bucket_id, path, title, content, content_hash)
      VALUES (1, 'aaaa1111', 1, '', '検索設計', '全文検索の設計方針。', 'h1')`);
    db.exec("INSERT INTO tags (id, path) VALUES (1, 'tech/db')");
    db.exec("INSERT INTO document_tags (document_id, tag_id) VALUES (1, 1)");
    db.exec(
      "INSERT INTO documents_fts (rowid, title, content, tags) VALUES (1, '検索設計', '全文検索の設計方針。', 'tech/db')",
    );

    migrate(db, CTX, 4);
    expect(schemaVersion(db)).toBe(4);

    // documents_fts was rebuilt with the aliases column; existing rows searchable again
    const hit = db
      .prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?")
      .all('"全文検索"');
    expect(hit).toEqual([{ rowid: 1 }]);
    const ftsRow = db
      .prepare("SELECT title, tags, aliases FROM documents_fts WHERE rowid = 1")
      .get();
    expect(ftsRow).toEqual({ title: "検索設計", tags: "tech/db", aliases: "" });

    // Alias uniqueness is case-insensitive per document
    db.exec("INSERT INTO document_aliases (document_id, alias) VALUES (1, 'FTS設計')");
    expect(() =>
      db.exec("INSERT INTO document_aliases (document_id, alias) VALUES (1, 'fts設計')"),
    ).toThrow(/UNIQUE/);
    db.close();
  });
});

describe("migration 005: document revisions (docs: data-model.md)", () => {
  test("v4 → v5 creates document_revisions with CASCADE delete", () => {
    const db = openRaw();
    migrate(db, CTX, 4);
    db.exec(`INSERT INTO documents (id, doc_key, bucket_id, path, title, content, content_hash)
      VALUES (1, 'aaaa1111', 1, '', '検索設計', '全文検索の設計方針。', 'h1')`);

    migrate(db, CTX);
    expect(schemaVersion(db)).toBe(5);

    db.exec(`INSERT INTO document_revisions (document_id, title, path, content, content_hash, saved_at)
      VALUES (1, '検索設計', '', '旧本文。', 'h0', '2026-07-01 00:00:00')`);
    db.exec("DELETE FROM documents WHERE id = 1");
    const rows = db.prepare("SELECT COUNT(*) AS n FROM document_revisions").get() as { n: number };
    expect(rows.n).toBe(0);
    db.close();
  });
});
