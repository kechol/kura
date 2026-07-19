import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import { createDocument } from "../src/core/documents";
import { suggestedPath, suggestPathForDocument } from "../src/core/filing";
import type { LLMProvider } from "../src/core/llm/provider";

let db: Database;
const config = defaultConfig();

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
});

afterEach(() => {
  db.close();
});

/** Deterministic mock (testing.md R2 — never a live provider) */
const mockProvider: LLMProvider = {
  name: "ollama",
  isAvailable: async () => true,
  hasModel: async () => true,
  embed: async (texts) => texts.map(() => new Float32Array(4)),
  chat: async () => '{"path": " 検索/設計 ", "reason": "検索設計に関するメモのため"}',
};

describe("kura mv suggest core (docs: cli-reference.md)", () => {
  test("link and tag signals vote for the neighbor's path (no provider — degraded)", async () => {
    createDocument(db, {
      title: "SQLiteの内部構造",
      content: "Btree の話。 #tech/db",
      bucket: "main",
      path: "db/sqlite",
    });
    const doc = createDocument(db, {
      title: "WALメモ",
      content: "[[SQLiteの内部構造]] を参照。 #tech/db",
      bucket: "main",
    });

    const s = await suggestPathForDocument(db, "trigram", config, null, doc);
    expect(s.llm).toBeNull();
    expect(s.candidates[0]?.path).toBe("db/sqlite");
    // link (3) + shared tag (1); evidence carries both signals
    expect(s.candidates[0]?.score).toBeGreaterThanOrEqual(4);
    expect(s.candidates[0]?.evidence.join(" ")).toContain("link: [[SQLiteの内部構造]]");
    expect(suggestedPath(s)).toBe("db/sqlite");
  });

  test("the LLM pick wins over signal candidates and is normalized", async () => {
    createDocument(db, {
      title: "SQLiteの内部構造",
      content: "Btree の話。",
      bucket: "main",
      path: "db/sqlite",
    });
    const doc = createDocument(db, {
      title: "検索設計メモ",
      content: "[[SQLiteの内部構造]] を参照しつつ検索を設計する。",
      bucket: "main",
    });

    const s = await suggestPathForDocument(db, "trigram", config, mockProvider, doc);
    expect(s.llm?.path).toBe("検索/設計");
    expect(s.llm?.isNew).toBe(true);
    expect(s.llm?.reason).toContain("検索設計");
    expect(suggestedPath(s)).toBe("検索/設計");
    // Structural candidates are still reported alongside
    expect(s.candidates.map((c) => c.path)).toContain("db/sqlite");
  });

  test("a document with no signals yields no suggestion, without erroring", async () => {
    const doc = createDocument(db, { title: "無関係な単独メモ", content: "☃", bucket: "main" });
    const s = await suggestPathForDocument(db, "trigram", config, null, doc);
    expect(s.candidates).toEqual([]);
    expect(suggestedPath(s)).toBeNull();
  });

  test("an unusable LLM answer falls back to the top signal candidate", async () => {
    const broken: LLMProvider = { ...mockProvider, chat: async () => "path は db ですかね" };
    createDocument(db, {
      title: "SQLiteの内部構造",
      content: "x",
      bucket: "main",
      path: "db/sqlite",
    });
    const doc = createDocument(db, {
      title: "WALメモ",
      content: "[[SQLiteの内部構造]]",
      bucket: "main",
    });
    const s = await suggestPathForDocument(db, "trigram", config, broken, doc);
    expect(s.llm).toBeNull();
    expect(suggestedPath(s)).toBe("db/sqlite");
  });
});
