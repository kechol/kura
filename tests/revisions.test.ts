import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/core/db";
import { createDocument, updateDocument } from "../src/core/documents";
import {
  getRevision,
  listRevisions,
  MAX_REVISIONS_PER_DOC,
  snapshotRevision,
  stateAsOf,
} from "../src/core/revisions";

let db: Database;

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
});

afterEach(() => {
  db.close();
});

/** Clock control: age every revision row out of the coalesce window */
function ageRevisions(): void {
  db.exec("UPDATE document_revisions SET created_at = datetime('now', '-1 hour')");
}

describe("revision snapshots via updateDocument", () => {
  test("a content change snapshots the replaced state", () => {
    const doc = createDocument(db, {
      title: "検索設計",
      content: "初版の方針。",
      bucket: "main",
    });
    updateDocument(db, doc.id, { content: "改訂した方針。" });

    const revisions = listRevisions(db, doc.id);
    expect(revisions.length).toBe(1);
    const rev = getRevision(db, doc.id, revisions[0]!.id);
    expect(rev.content).toBe("初版の方針。");
    expect(rev.title).toBe("検索設計");
    expect(rev.savedAt).toBe(doc.updatedAt);
  });

  test("rapid saves coalesce into one revision per burst", () => {
    const doc = createDocument(db, { title: "メモ", content: "v1。", bucket: "main" });
    updateDocument(db, doc.id, { content: "v2。" });
    updateDocument(db, doc.id, { content: "v3。" });
    updateDocument(db, doc.id, { content: "v4。" });
    expect(listRevisions(db, doc.id).length).toBe(1);
    expect(getRevision(db, doc.id, listRevisions(db, doc.id)[0]!.id).content).toBe("v1。");

    ageRevisions();
    updateDocument(db, doc.id, { content: "v5。" });
    const revisions = listRevisions(db, doc.id);
    expect(revisions.length).toBe(2);
    expect(getRevision(db, doc.id, revisions[0]!.id).content).toBe("v4。");
  });

  test("a rename snapshots even inside the coalesce window", () => {
    const doc = createDocument(db, { title: "旧タイトル", content: "本文。", bucket: "main" });
    updateDocument(db, doc.id, { content: "改訂。" });
    updateDocument(db, doc.id, { title: "新タイトル" });
    const revisions = listRevisions(db, doc.id);
    expect(revisions.length).toBe(2);
    expect(revisions[0]?.title).toBe("旧タイトル");
  });

  test("a metadata-only update (tags) does not snapshot", () => {
    const doc = createDocument(db, { title: "メモ", content: "本文。", bucket: "main" });
    updateDocument(db, doc.id, { tags: ["tech/db"] });
    expect(listRevisions(db, doc.id)).toEqual([]);
  });

  test("restoring an old revision snapshots the replaced state first", () => {
    const doc = createDocument(db, { title: "メモ", content: "v1。", bucket: "main" });
    updateDocument(db, doc.id, { content: "v2。" });
    ageRevisions();

    const v1 = listRevisions(db, doc.id)[0]!;
    updateDocument(db, doc.id, { content: getRevision(db, doc.id, v1.id).content });

    const revisions = listRevisions(db, doc.id);
    expect(revisions.length).toBe(2);
    expect(getRevision(db, doc.id, revisions[0]!.id).content).toBe("v2。");
    const current = db.prepare("SELECT content FROM documents WHERE id = ?").get(doc.id) as {
      content: string;
    };
    expect(current.content).toBe("v1。");
  });
});

describe("snapshotRevision internals", () => {
  test("dedup: an identical state is not snapshotted twice", () => {
    const doc = createDocument(db, { title: "メモ", content: "v1。", bucket: "main" });
    const input = {
      docId: doc.id,
      title: "メモ",
      path: "",
      content: "v1。",
      contentHash: "h1",
      savedAt: "2026-07-01 00:00:00",
    };
    expect(snapshotRevision(db, input)).toBe(true);
    ageRevisions();
    expect(snapshotRevision(db, input)).toBe(false);
  });

  test("prunes to MAX_REVISIONS_PER_DOC, dropping the oldest", () => {
    const doc = createDocument(db, { title: "メモ", content: "v0。", bucket: "main" });
    for (let i = 1; i <= MAX_REVISIONS_PER_DOC + 5; i++) {
      snapshotRevision(db, {
        docId: doc.id,
        title: "メモ",
        path: "",
        content: `v${i}。`,
        contentHash: `h${i}`,
        savedAt: "2026-07-01 00:00:00",
      });
      ageRevisions();
    }
    const revisions = listRevisions(db, doc.id);
    expect(revisions.length).toBe(MAX_REVISIONS_PER_DOC);
    expect(getRevision(db, doc.id, revisions[revisions.length - 1]!.id).content).toBe("v6。");
  });
});

describe("stateAsOf (kura get --as-of)", () => {
  test("returns the state whose validity covers the time", () => {
    const doc = createDocument(db, {
      title: "設計メモ",
      content: "v1。",
      bucket: "main",
      createdAt: "2026-01-01 00:00:00",
    });
    updateDocument(db, doc.id, { content: "v2。", updatedAt: "2026-02-01 00:00:00" });
    ageRevisions();
    updateDocument(db, doc.id, { content: "v3。", updatedAt: "2026-03-01 00:00:00" });

    const jan = stateAsOf(db, doc.id, "2026-01-15 00:00:00");
    expect(jan?.source).toBe("revision");
    expect(jan?.content).toBe("v1。");

    const feb = stateAsOf(db, doc.id, "2026-02-15 00:00:00");
    expect(feb?.source).toBe("revision");
    expect(feb?.content).toBe("v2。");

    const now = stateAsOf(db, doc.id, "2026-03-15 00:00:00");
    expect(now?.source).toBe("current");
    expect(now?.content).toBe("v3。");

    expect(stateAsOf(db, doc.id, "2025-12-01 00:00:00")).toBeNull();
  });
});

describe("kura history / get --as-of CLI", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

  async function runCli(
    args: string[],
    env: Record<string, string>,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", "run", CLI, ...args], {
      env: { ...process.env, NO_COLOR: "1", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  test("history list / show / restore and get --as-of", async () => {
    const home = mkdtempSync(join(tmpdir(), "kura-history-cli-"));
    const env = { KURA_HOME: home, KURA_DB: join(home, "kura.db") };
    try {
      const init = await runCli(["init", "--no-download"], env);
      expect(init.code).toBe(0);

      const cliDb = openDatabase({ path: env.KURA_DB, vaporettoPath: null }).db;
      const doc = createDocument(cliDb, {
        title: "設計メモ",
        content: "v1。",
        bucket: "main",
        createdAt: "2026-01-01 00:00:00",
      });
      updateDocument(cliDb, doc.id, { content: "v2。", updatedAt: "2026-02-01 00:00:00" });
      cliDb.close();

      const list = await runCli(["history", "設計メモ", "--json"], env);
      expect(list.code).toBe(0);
      const parsed = JSON.parse(list.stdout);
      expect(parsed.revisions.length).toBe(1);
      const revId: number = parsed.revisions[0].id;

      const show = await runCli(["history", "show", "設計メモ", `r${revId}`], env);
      expect(show.code).toBe(0);
      expect(show.stdout.trim()).toBe("v1。");

      const asOf = await runCli(["get", "設計メモ", "--as-of", "2026-01-15", "--raw"], env);
      expect(asOf.code).toBe(0);
      expect(asOf.stdout.trim()).toBe("v1。");

      const tooEarly = await runCli(["get", "設計メモ", "--as-of", "2025-12-01"], env);
      expect(tooEarly.code).toBe(3);

      const restore = await runCli(["history", "restore", "設計メモ", `r${revId}`], env);
      expect(restore.code).toBe(0);
      const current = await runCli(["get", "設計メモ", "--raw"], env);
      expect(current.stdout.trim()).toBe("v1。");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
