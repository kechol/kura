import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type KuraConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import {
  createDocument,
  getDocumentById,
  markTriaged,
  updateDocument,
} from "../src/core/documents";
import type { LLMProvider, Message } from "../src/core/llm/provider";
import { setProviderForTests } from "../src/core/llm/provider";
import { listTriageBacklog, triageDocument } from "../src/core/triage";
import { runCli } from "./helpers";

/**
 * Mock provider (testing.md R2) that branches on the Japanese prompt constants
 * baked into each organizing engine: titling.ts (タイトル), tagging.ts (タグ付け),
 * dedupe.ts (重複), linking.ts (関連付け), filing.ts (path/保存すべき). Embeddings
 * are deterministic keyword vectors.
 */
class TriageMockProvider implements LLMProvider {
  name = "ollama" as const;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async hasModel(): Promise<boolean> {
    return true;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(4);
      if (/SQLite|WAL|Btree/.test(t)) v[0] = 1;
      else if (/犬|散歩/.test(t)) v[1] = 1;
      else v[3] = 1;
      return v;
    });
  }
  async chat(messages: Message[]): Promise<string> {
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("タイトル")) {
      return '{"title": "SQLite WAL モード入門", "reason": "内容に即した具体的なタイトル"}';
    }
    if (system.includes("タグ付け")) {
      return '["技術/データベース", "技術/sqlite"]';
    }
    if (system.includes("重複")) {
      return '{"duplicate": true, "keep": "a", "reason": "ほぼ同一の内容"}';
    }
    if (system.includes("関連付け")) {
      return "yes";
    }
    // filing PATH_PROMPT ("保存すべき path")
    return '{"path": "db/sqlite", "reason": "SQLite 関連のため"}';
  }
}

let db: Database;
let config: KuraConfig;

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
  config = defaultConfig();
  config.llm.models.embedding_dimensions = 4;
});

afterEach(() => {
  setProviderForTests(undefined);
  db.close();
});

describe("listTriageBacklog (core)", () => {
  test("includes unfiled or untagged docs; excludes filed + tagged", () => {
    // unfiled (path ''), but tagged
    const unfiled = createDocument(db, {
      title: "未整理メモ",
      content: "本文。 #タグ",
      bucket: "main",
    });
    // filed (path db), but untagged
    const untagged = createDocument(db, {
      title: "無タグメモ",
      content: "本文のみ。",
      bucket: "main",
      path: "db",
    });
    // filed + tagged -> not in the backlog
    const filed = createDocument(db, {
      title: "整理済み",
      content: "本文。 #タグ",
      bucket: "main",
      path: "db",
    });

    const keys = listTriageBacklog(db, "main").map((id) => getDocumentById(db, id).key);
    expect(keys).toContain(unfiled.key);
    expect(keys).toContain(untagged.key);
    expect(keys).not.toContain(filed.key);
  });

  test("excludes a doc triaged after its last edit; re-includes after a content edit; redo ignores triaged_at", () => {
    const doc = createDocument(db, {
      title: "整理対象",
      content: "初版。",
      bucket: "main",
      updatedAt: "2026-01-01 00:00:00",
    });
    expect(listTriageBacklog(db, "main").map((id) => getDocumentById(db, id).key)).toContain(doc.key);

    // Triage stamps a time strictly after updated_at -> drops out of the backlog
    markTriaged(db, doc.id, "2026-01-02 00:00:00");
    expect(listTriageBacklog(db, "main").map((id) => getDocumentById(db, id).key)).not.toContain(doc.key);
    // redo ignores triaged_at
    expect(listTriageBacklog(db, "main", { redo: true }).map((id) => getDocumentById(db, id).key)).toContain(doc.key);

    // A later content edit moves updated_at past triaged_at -> back in the backlog
    updateDocument(db, doc.id, { content: "改訂版。", updatedAt: "2026-01-03 00:00:00" });
    expect(listTriageBacklog(db, "main").map((id) => getDocumentById(db, id).key)).toContain(doc.key);
  });

  test("limit caps and ordering is updated_at DESC", () => {
    createDocument(db, { title: "A", content: "あ", bucket: "main", updatedAt: "2026-01-01 00:00:00" });
    createDocument(db, { title: "B", content: "い", bucket: "main", updatedAt: "2026-03-01 00:00:00" });
    createDocument(db, { title: "C", content: "う", bucket: "main", updatedAt: "2026-02-01 00:00:00" });

    expect(listTriageBacklog(db, "main").map((id) => getDocumentById(db, id).title)).toEqual(["B", "C", "A"]);
    expect(listTriageBacklog(db, "main", { limit: 2 }).map((id) => getDocumentById(db, id).title)).toEqual(["B", "C"]);
  });
});

describe("markTriaged (core)", () => {
  test("sets triagedAt without touching updatedAt", () => {
    const doc = createDocument(db, {
      title: "対象",
      content: "本文",
      bucket: "main",
      updatedAt: "2026-01-01 00:00:00",
    });
    const before = getDocumentById(db, doc.id);
    expect(before.triagedAt).toBeNull();

    markTriaged(db, doc.id, "2026-05-05 05:05:05");
    const after = getDocumentById(db, doc.id);
    expect(after.triagedAt).toBe("2026-05-05 05:05:05");
    expect(after.updatedAt).toBe(before.updatedAt);
  });
});

describe("triageDocument (core)", () => {
  let mock: TriageMockProvider;

  beforeEach(() => {
    mock = new TriageMockProvider();
    setProviderForTests(mock);
  });

  test("title step parses the model's suggestion", async () => {
    const doc = createDocument(db, {
      title: "無題メモ",
      content: "WAL モードの解説。チェックポイントの挙動を理解する。",
      bucket: "main",
    });
    const report = await triageDocument(db, "trigram", config, mock, doc, ["title"]);
    expect(report.title?.title).toBe("SQLite WAL モード入門");
    expect(report.warnings).toEqual([]);
  });

  test("tags step drops tags already on the document", async () => {
    const doc = createDocument(db, {
      title: "SQLiteの記事",
      content: "本文。 #技術/データベース",
      bucket: "main",
    });
    expect(doc.tags).toContain("技術/データベース");
    const report = await triageDocument(db, "trigram", config, mock, doc, ["tags"]);
    // mock suggests ["技術/データベース", "技術/sqlite"]; the already-present one is filtered out
    expect(report.tags).toEqual(["技術/sqlite"]);
  });

  test("path step runs only for unfiled documents", async () => {
    const filed = createDocument(db, {
      title: "整理済み",
      content: "本文。",
      bucket: "main",
      path: "db",
    });
    const filedReport = await triageDocument(db, "trigram", config, mock, filed, ["path"]);
    expect(filedReport.path).toBeUndefined();

    const unfiled = createDocument(db, { title: "未整理", content: "本文。", bucket: "main" });
    const unfiledReport = await triageDocument(db, "trigram", config, mock, unfiled, ["path"]);
    expect(unfiledReport.path?.path).toBe("db/sqlite");
    expect(unfiledReport.path?.source).toBe("llm");
  });

  test("provider = null still produces a report; warnings aggregate, dedupe, and flag skipped LLM steps", async () => {
    const doc = createDocument(db, {
      title: "下書き",
      content: "[[存在しない参照]] を含むメモ。",
      bucket: "main",
    });
    const report = await triageDocument(db, "trigram", config, null, doc, [
      "dedupe",
      "title",
      "tags",
      "path",
      "links",
    ]);

    expect(report.doc.key).toBe(doc.key);
    expect(report.warnings.length).toBeGreaterThan(0);
    // aggregated warnings are de-duplicated (invariants R4 degraded path)
    expect(new Set(report.warnings).size).toBe(report.warnings.length);
    expect(report.warnings.some((w) => w.includes("no LLM provider"))).toBe(true);
    // LLM-only engines produced nothing
    expect(report.title).toBeNull();
    expect(report.tags).toBeUndefined();
  });
});

describe("kura triage CLI (degraded, provider none)", () => {
  let home: string;
  let env: Record<string, string>;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), "kura-triage-cli-"));
    env = { KURA_HOME: home, KURA_DB: join(home, "kura.db") };
    const init = await runCli(["init", "--no-download"], env);
    expect(init.code).toBe(0);
    // Pin the provider off so the subprocess never talks to a local Ollama (testing.md R2)
    writeFileSync(join(home, "config.toml"), '[llm]\nprovider = "none"\n');

    // Fixtures via direct repository writes (the commands-taglink.test.ts idiom):
    // one filed + tagged doc, and one unfiled + untagged doc that links to it.
    const conn = openDatabase({ path: env.KURA_DB, vaporettoPath: null });
    try {
      createDocument(conn.db, {
        title: "SQLiteの内部構造",
        content: "Btree の話。 #tech/db",
        bucket: "main",
        path: "db/sqlite",
      });
      createDocument(conn.db, {
        title: "WALメモ",
        content: "[[SQLiteの内部構造]] を参照。",
        bucket: "main",
      });
    } finally {
      conn.db.close();
    }
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("--json returns the documented shape and mutates nothing", async () => {
    const first = await runCli(["triage", "--json", "--bucket", "main"], env);
    expect(first.code).toBe(0);
    expect(first.stderr).toContain("no LLM provider");

    const results = JSON.parse(first.stdout) as Array<{
      key: string;
      title: string;
      steps: { path?: { path: string; source: string } };
      warnings: string[];
    }>;
    // Only the unfiled + untagged WALメモ is in the backlog (the filed + tagged doc is not)
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe("WALメモ");
    expect(results[0]?.steps.path).toEqual({ path: "db/sqlite", source: "signals" });
    expect(Array.isArray(results[0]?.warnings)).toBe(true);

    // Nothing was written: the doc is still at the bucket root and a second run sees it again
    const get = await runCli(["get", "WALメモ", "--json"], env);
    expect(JSON.parse(get.stdout).path).toBe("");
    const second = await runCli(["triage", "--json", "--bucket", "main"], env);
    expect((JSON.parse(second.stdout) as unknown[]).length).toBe(1);
  }, 30_000);

  test("--apply files the doc from signals, stamps triaged, and --redo re-includes it", async () => {
    const apply = await runCli(["triage", "--apply", "--bucket", "main"], env);
    expect(apply.code).toBe(0);
    expect(apply.stdout).toContain("moved -> db/sqlite/WALメモ");

    const get = await runCli(["get", "db/sqlite/WALメモ", "--json"], env);
    expect(get.code).toBe(0);
    expect(JSON.parse(get.stdout).path).toBe("db/sqlite");

    // Marked triaged (and just edited by the move) -> nothing left in the backlog
    const after = await runCli(["triage", "--json", "--bucket", "main"], env);
    expect(after.stdout.trim()).toBe("[]");

    // redo ignores triaged_at; WALメモ is still untagged so it re-enters the backlog
    const redo = await runCli(["triage", "--json", "--redo", "--bucket", "main"], env);
    const redoResults = JSON.parse(redo.stdout) as Array<{ title: string }>;
    expect(redoResults.map((r) => r.title)).toContain("WALメモ");
  }, 30_000);

  test("--json and --apply are mutually exclusive (exit 2)", async () => {
    const r = await runCli(["triage", "--json", "--apply", "--bucket", "main"], env);
    expect(r.code).toBe(2);
  }, 30_000);

  test("an unknown --steps value exits 2", async () => {
    const r = await runCli(["triage", "--steps", "bogus", "--bucket", "main"], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown step");
  }, 30_000);

  test("kura status prints the triage backlog line", async () => {
    const r = await runCli(["status"], env);
    expect(r.code).toBe(0);
    // WALメモ is both unfiled and untagged; the filed + tagged doc is neither
    expect(r.stdout).toContain("backlog:");
    expect(r.stdout).toContain("1 unfiled");
    expect(r.stdout).toContain("1 untagged");
    expect(r.stdout).toContain("run 'kura triage'");
  }, 30_000);
});
