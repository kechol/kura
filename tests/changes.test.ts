import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBucket } from "../src/core/buckets";
import { changesSince, parseSince } from "../src/core/changes";
import { openDatabase } from "../src/core/db";
import { createDocument, updateDocument } from "../src/core/documents";

let db: Database;

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
});

afterEach(() => {
  db.close();
});

describe("parseSince", () => {
  test("relative and absolute forms; garbage is null", () => {
    expect(parseSince("2026-07-01")).toBe("2026-07-01 00:00:00");
    expect(parseSince("7d")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(parseSince("そのうち")).toBeNull();
  });
});

describe("changesSince", () => {
  test("separates created from updated and detects what changed", () => {
    const a = createDocument(db, {
      title: "検索設計",
      content: "v1。",
      bucket: "main",
      createdAt: "2026-01-01 00:00:00",
    });
    updateDocument(db, a.id, { content: "v2。", updatedAt: "2026-03-01 00:00:00" });
    createDocument(db, {
      title: "新しいメモ",
      content: "初版。",
      bucket: "main",
      createdAt: "2026-03-05 00:00:00",
    });

    const changes = changesSince(db, "2026-02-01 00:00:00");
    expect(changes.map((c) => [c.title, c.kind])).toEqual([
      ["新しいメモ", "created"],
      ["検索設計", "updated"],
    ]);
    const updated = changes[1]!;
    expect(updated.contentChanged).toBe(true);
    expect(updated.renamed).toBe(false);
    expect(updated.previousTitle).toBe("検索設計");

    expect(changesSince(db, "2026-04-01 00:00:00")).toEqual([]);
  });

  test("detects renames against the revision history", () => {
    const a = createDocument(db, {
      title: "旧タイトル",
      content: "本文。",
      bucket: "main",
      createdAt: "2026-01-01 00:00:00",
    });
    updateDocument(db, a.id, { title: "新タイトル", updatedAt: "2026-03-01 00:00:00" });

    const [change] = changesSince(db, "2026-02-01 00:00:00");
    expect(change?.kind).toBe("updated");
    expect(change?.renamed).toBe(true);
    expect(change?.previousTitle).toBe("旧タイトル");
    expect(change?.contentChanged).toBe(false);
  });

  test("bucket filter and limit", () => {
    createBucket(db, "work");
    createDocument(db, { title: "メモA", content: "a。", bucket: "main" });
    createDocument(db, { title: "メモB", content: "b。", bucket: "work" });
    createDocument(db, { title: "メモC", content: "c。", bucket: "work" });

    const work = changesSince(db, "2020-01-01 00:00:00", { bucket: "work" });
    expect(work.map((c) => c.title).sort()).toEqual(["メモB", "メモC"]);
    expect(changesSince(db, "2020-01-01 00:00:00", { limit: 1 }).length).toBe(1);
  });
});

describe("kura changes CLI", () => {
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

  test("changes --since with relative time and --json", async () => {
    const home = mkdtempSync(join(tmpdir(), "kura-changes-cli-"));
    const env = { KURA_HOME: home, KURA_DB: join(home, "kura.db") };
    try {
      const init = await runCli(["init", "--no-download"], env);
      expect(init.code).toBe(0);

      const cliDb = openDatabase({ path: env.KURA_DB, vaporettoPath: null }).db;
      createDocument(cliDb, { title: "設計メモ", content: "本文。", bucket: "main" });
      cliDb.close();

      const json = await runCli(["changes", "--since", "1h", "--json"], env);
      expect(json.code).toBe(0);
      const parsed = JSON.parse(json.stdout);
      expect(parsed.changes.length).toBe(1);
      expect(parsed.changes[0].kind).toBe("created");
      expect(parsed.changes[0].title).toBe("設計メモ");

      const missing = await runCli(["changes"], env);
      expect(missing.code).toBe(2);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
