import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig, type KuraConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import { createDocument } from "../src/core/documents";
import type { LLMProvider, Message } from "../src/core/llm/provider";
import { setProviderForTests } from "../src/core/llm/provider";
import { blendScores, hybridQuery } from "../src/core/search/hybrid";
import { buildTrigramQuery, keywordSearch } from "../src/core/search/keyword";
import { parseYesNo } from "../src/core/search/rerank";
import { backfillEmbeddings, pendingChunkCount, vectorSearch } from "../src/core/search/vector";

/**
 * Deterministic mock provider:
 * - embed: 4-dimensional vectors based on keyword occurrence
 * - chat: rerank answers yes when the document contains the query term; expand returns fixed variants
 */
class MockProvider implements LLMProvider {
  name = "ollama" as const;
  embedCalls = 0;
  chatCalls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async hasModel(): Promise<boolean> {
    return true;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls++;
    return texts.map((t) => {
      const v = new Float32Array(4);
      if (t.includes("猫")) v[0] = 1;
      if (t.includes("犬")) v[1] = 1;
      if (t.includes("データベース")) v[2] = 1;
      if (v[0] === 0 && v[1] === 0 && v[2] === 0) v[3] = 1;
      return v;
    });
  }

  async chat(messages: Message[]): Promise<string> {
    this.chatCalls++;
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    const queryMatch = user.match(/<Query>: (.*)\n/);
    if (queryMatch) {
      const doc = user.slice(user.indexOf("<Document>:"));
      const term = (queryMatch[1] ?? "").split(/\s+/)[0] ?? "";
      return doc.includes(term) ? "yes" : "no";
    }
    // expand
    return '["ネコ 生態", "cat 飼育"]';
  }
}

let db: Database;
let config: KuraConfig;
let mock: MockProvider;

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
  config = defaultConfig();
  config.llm.models.embedding_dimensions = 4;
  mock = new MockProvider();
  setProviderForTests(mock);
});

afterEach(() => {
  setProviderForTests(undefined);
  db.close();
});

function seedDocs(): void {
  createDocument(db, {
    title: "猫の飼い方",
    content: "猫はかわいい。毎日の餌やりと猫トイレの掃除が大切。 #ペット/猫",
    bucket: "main",
  });
  createDocument(db, {
    title: "犬のしつけ",
    content: "犬の散歩としつけについて。子犬の時期が重要。 #ペット/犬",
    bucket: "main",
  });
  createDocument(db, {
    title: "SQLite 入門",
    content: "データベースの基礎。SQLite は軽量なデータベースエンジン。 #tech/db",
    bucket: "main",
  });
}

describe("keywordSearch (trigram)", () => {
  test("title matches rank above content matches (bm25 weighting)", () => {
    createDocument(db, {
      title: "全文検索エンジンの比較",
      content: "各種エンジンの評価。",
      bucket: "main",
    });
    createDocument(db, {
      title: "メモ",
      content: "全文検索エンジンについて調べたことを書く。全文検索は便利。",
      bucket: "main",
    });
    const hits = keywordSearch(db, "trigram", "全文検索エンジン", {});
    expect(hits.length).toBe(2);
    expect(hits[0]?.title).toBe("全文検索エンジンの比較");
    expect(hits[1]?.snippet).toContain("**");
  });

  test("--all switches to AND search", () => {
    seedDocs();
    const or = keywordSearch(db, "trigram", "猫トイレ しつけ", {});
    const and = keywordSearch(db, "trigram", "猫トイレ しつけ", { all: true });
    expect(or.length).toBe(2);
    expect(and.length).toBe(0);
  });

  test("bucket / tag filters", () => {
    seedDocs();
    expect(keywordSearch(db, "trigram", "データベース", { tag: "tech" }).length).toBe(1);
    expect(keywordSearch(db, "trigram", "データベース", { tag: "ペット" }).length).toBe(0);
  });

  test("queries shorter than 3 characters hit via the LIKE fallback", () => {
    seedDocs();
    const hits = keywordSearch(db, "trigram", "猫", {});
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.title).toBe("猫の飼い方");
    expect(hits[0]?.snippet).toContain("**猫**");
  });

  test("buildTrigramQuery escapes phrases", () => {
    expect(buildTrigramQuery('猫 "cat"', false)).toBe('"猫" OR """cat"""');
    expect(buildTrigramQuery("a b", true)).toBe('"a" AND "b"');
  });
});

describe("vector search + backfill", () => {
  test("backfill -> KNN -> per-document aggregation", async () => {
    seedDocs();
    expect(pendingChunkCount(db)).toBeGreaterThan(0);

    const result = await backfillEmbeddings(db, mock, config);
    expect(result.embedded).toBe(result.total);
    expect(pendingChunkCount(db)).toBe(0);

    const hits = await vectorSearch(db, mock, config, "猫のごはん", {});
    expect(hits[0]?.title).toBe("猫の飼い方");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
    // Snippets do not include the context header
    expect(hits[0]?.snippet.startsWith("#")).toBe(false);
  });

  test("--all regenerates everything", async () => {
    seedDocs();
    await backfillEmbeddings(db, mock, config);
    const before = mock.embedCalls;
    const result = await backfillEmbeddings(db, mock, config, { all: true });
    expect(result.embedded).toBeGreaterThan(0);
    expect(mock.embedCalls).toBeGreaterThan(before);
  });

  test("dimension mismatch raises an error with guidance", async () => {
    seedDocs();
    config.llm.models.embedding_dimensions = 8;
    expect(backfillEmbeddings(db, mock, config)).rejects.toThrow(/embed --all/);
  });
});

describe("hybridQuery", () => {
  test("fuses FTS + vector + rerank (provider available)", async () => {
    seedDocs();
    const outcome = await hybridQuery(db, "trigram", config, "猫の飼い方", { limit: 3 });
    expect(outcome.usedVector).toBe(true);
    expect(outcome.usedRerank).toBe(true);
    expect(outcome.hits[0]?.title).toBe("猫の飼い方");
    expect(outcome.hits[0]?.source).toBe("hybrid");
    expect(outcome.warnings).toEqual([]);
  });

  test("rerank results are cached in llm_cache", async () => {
    seedDocs();
    await hybridQuery(db, "trigram", config, "猫の飼い方", { limit: 3 });
    const callsAfterFirst = mock.chatCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);
    await hybridQuery(db, "trigram", config, "猫の飼い方", { limit: 3 });
    expect(mock.chatCalls).toBe(callsAfterFirst);
  });

  test("--expand adds variants (with cache)", async () => {
    seedDocs();
    const outcome = await hybridQuery(db, "trigram", config, "猫の飼い方", {
      limit: 3,
      expand: true,
    });
    expect(outcome.expandedQueries).toEqual(["ネコ 生態", "cat 飼育"]);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM llm_cache WHERE purpose = 'expand'")
      .get() as {
      n: number;
    };
    expect(row.n).toBe(1);
  });

  test("answers with keyword search when no provider is available (degraded operation)", async () => {
    seedDocs();
    setProviderForTests(null);
    const outcome = await hybridQuery(db, "trigram", config, "データベース", { limit: 3 });
    expect(outcome.usedVector).toBe(false);
    expect(outcome.usedRerank).toBe(false);
    expect(outcome.hits[0]?.title).toBe("SQLite 入門");
    expect(outcome.warnings.length).toBeGreaterThan(0);
  });
});

describe("scoring primitives", () => {
  test("parseYesNo", () => {
    expect(parseYesNo("yes")).toBe(1);
    expect(parseYesNo("  No.")).toBe(0);
    expect(parseYesNo("<think>考え中...</think>\nYes")).toBe(1);
    expect(parseYesNo("わかりません")).toBe(0.5);
  });

  test("blendScores position weighting (docs: search-pipeline.md)", () => {
    expect(blendScores(1, 0, 1)).toBeCloseTo(0.75);
    expect(blendScores(1, 0, 5)).toBeCloseTo(0.6);
    expect(blendScores(1, 0, 11)).toBeCloseTo(0.4);
    expect(blendScores(0, 1, 11)).toBeCloseTo(0.6);
  });
});
