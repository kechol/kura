import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureVaporetto } from "../src/core/bootstrap";
import { resetConfigCache } from "../src/core/config";
import { closeDb, getDb, getMeta, openDatabase, schemaVersion, setMeta } from "../src/core/db";

let home: string;
const envBackup: Record<string, string | undefined> = {};

beforeEach(() => {
  envBackup.KURA_HOME = process.env.KURA_HOME;
  envBackup.KURA_DB = process.env.KURA_DB;
  home = mkdtempSync(join(tmpdir(), "kura-db-test-"));
  process.env.KURA_HOME = home;
  delete process.env.KURA_DB;
  resetConfigCache();
});

afterEach(() => {
  closeDb();
  process.env.KURA_HOME = envBackup.KURA_HOME;
  process.env.KURA_DB = envBackup.KURA_DB;
  if (envBackup.KURA_HOME === undefined) delete process.env.KURA_HOME;
  if (envBackup.KURA_DB === undefined) delete process.env.KURA_DB;
  resetConfigCache();
  rmSync(home, { recursive: true, force: true });
});

describe("openDatabase", () => {
  test("新規 DB にマイグレーション v1 が適用される（vaporetto なし → trigram）", () => {
    const { db, tokenizer, vaporettoLoaded } = openDatabase({
      path: ":memory:",
      vaporettoPath: null,
    });
    expect(schemaVersion(db)).toBe(1);
    expect(tokenizer).toBe("trigram");
    expect(vaporettoLoaded).toBe(false);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    for (const t of [
      "buckets",
      "documents",
      "tags",
      "document_tags",
      "links",
      "chunks",
      "documents_fts",
      "chunks_vec",
      "llm_cache",
      "meta",
    ]) {
      expect(tables).toContain(t);
    }
    // 既定 Bucket
    const bucket = db.prepare("SELECT name FROM buckets").get() as { name: string };
    expect(bucket.name).toBe("main");
    // meta 記録
    expect(getMeta(db, "fts_tokenizer")).toBe("trigram");
    expect(getMeta(db, "embedding_model")).toBe("qwen3-embedding:0.6b");
    expect(getMeta(db, "embedding_dimensions")).toBe("1024");
    db.close();
  });

  test("再オープンしても冪等（マイグレーション再適用なし・meta 保持）", () => {
    const path = join(home, "kura.db");
    const first = openDatabase({ path, vaporettoPath: null });
    setMeta(first.db, "fts_tokenizer", "trigram");
    first.db.close();

    const second = openDatabase({ path, vaporettoPath: null });
    expect(schemaVersion(second.db)).toBe(1);
    expect(second.tokenizer).toBe("trigram");
    second.db.close();
  });

  test("chunks_vec が指定次元で作成され KNN が動く", () => {
    const { db } = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 });
    db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)").run(
      1,
      JSON.stringify([0.1, 0.2, 0.3, 0.4]),
    );
    const rows = db
      .prepare("SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = 1")
      .all(JSON.stringify([0.1, 0.2, 0.3, 0.4])) as Array<{ chunk_id: number }>;
    expect(rows.length).toBe(1);
    expect(rows[0]?.chunk_id).toBe(1);
    db.close();
  });

  test("trigram FTS で日本語（3文字以上）が検索できる", () => {
    const { db } = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 });
    db.prepare("INSERT INTO documents_fts (rowid, title, content, tags) VALUES (1, ?, ?, ?)").run(
      "SQLite メモ",
      "東京で全文検索の実験をした",
      "tech/db",
    );
    const rows = db
      .prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH ?")
      .all('"全文検索"');
    expect(rows.length).toBe(1);
    db.close();
  });

  test("外部キー制約が有効", () => {
    const { db } = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 });
    expect(() =>
      db
        .prepare(
          "INSERT INTO documents (doc_key, bucket_id, title, content, content_hash) VALUES ('k1', 999, 't', 'c', 'h')",
        )
        .run(),
    ).toThrow();
    db.close();
  });
});

describe("getDb", () => {
  test("DB 未作成なら kura init を案内して例外", () => {
    process.env.KURA_DB = join(home, "missing.db");
    expect(() => getDb()).toThrow(/kura init/);
  });

  test(":memory: は初期化なしで利用できる（テスト用経路）", () => {
    process.env.KURA_DB = ":memory:";
    const { db, tokenizer } = getDb();
    expect(tokenizer).toBe("trigram");
    expect(schemaVersion(db)).toBe(1);
  });
});

// 実ダウンロード + vaporetto ロードの統合テスト。
// ネットワークと外部ネイティブコード実行を伴うため KURA_TEST_DOWNLOAD=1 のときのみ実行（CI で有効化）
describe("vaporetto integration", () => {
  test.skipIf(!process.env.KURA_TEST_DOWNLOAD)(
    "GitHub Releases から取得 → SHA256 検証 → ロード → 日本語トークナイズ",
    async () => {
      const lib = await ensureVaporetto({ download: true });
      expect(lib).toBeTruthy();
      expect(existsSync(lib!)).toBe(true);

      const { db, tokenizer } = openDatabase({ path: ":memory:", vaporettoPath: lib });
      expect(tokenizer).toBe("vaporetto");
      db.prepare("INSERT INTO documents_fts (rowid, title, content, tags) VALUES (1, ?, ?, ?)").run(
        "検索メモ",
        "東京特許許可局で検索エンジンの実験をした",
        "",
      );
      const rows = db
        .prepare("SELECT rowid FROM documents_fts WHERE documents_fts MATCH vaporetto_or_query(?)")
        .all("検索エンジン");
      expect(rows.length).toBe(1);
      db.close();
    },
    120_000,
  );
});
