import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBucket } from "../src/core/buckets";
import { defaultConfig, type KuraConfig } from "../src/core/config";
import { getMeta, openDatabase } from "../src/core/db";
import { recreateVecIfModelChanged } from "../src/core/doctor";
import { createDocument, deleteDocument, updateDocument } from "../src/core/documents";
import type { LLMProvider, Message } from "../src/core/llm/provider";
import { setProviderForTests } from "../src/core/llm/provider";
import { blendScores, hybridQuery } from "../src/core/search/hybrid";
import { buildTrigramQuery, keywordSearch } from "../src/core/search/keyword";
import { parseYesNo, rerankCandidates } from "../src/core/search/rerank";
import {
  backfillEmbeddings,
  ensureEmbeddings,
  pendingChunkCount,
  resetEmbeddingIndex,
  vectorSearch,
} from "../src/core/search/vector";

/**
 * Deterministic mock provider:
 * - embed: 4-dimensional vectors based on keyword occurrence
 * - chat: rerank answers yes when the document contains the query term; expand returns fixed variants
 */
class MockProvider implements LLMProvider {
  name = "ollama" as const;
  embedCalls = 0;
  embedBatchSizes: number[] = [];
  chatCalls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async hasModel(): Promise<boolean> {
    return true;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls++;
    this.embedBatchSizes.push(texts.length);
    return texts.map((text) => mockVector(text));
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

function mockVector(text: string, dimensions = 4): Float32Array {
  const vector = new Float32Array(dimensions);
  if (text.includes("猫")) vector[0] = 1;
  if (text.includes("犬") && dimensions > 1) vector[1] = 1;
  if (text.includes("データベース") && dimensions > 2) vector[2] = 1;
  if (vector.every((value) => value === 0)) vector[dimensions - 1] = 1;
  return vector;
}

class DeferredEmbedProvider extends MockProvider {
  private markStarted!: () => void;
  private completeBatch: (() => void) | null = null;
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  override async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls++;
    this.embedBatchSizes.push(texts.length);
    this.markStarted();
    return new Promise((resolve) => {
      this.completeBatch = () => resolve(texts.map((text) => mockVector(text)));
    });
  }

  release(): void {
    if (!this.completeBatch) throw new Error("embedding request has not started");
    this.completeBatch();
  }
}

class EightDimensionProvider extends MockProvider {
  override async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls++;
    this.embedBatchSizes.push(texts.length);
    return texts.map((text) => mockVector(text, 8));
  }
}

class InterruptedProvider extends MockProvider {
  override async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls++;
    this.embedBatchSizes.push(texts.length);
    if (this.embedCalls === 2) throw new Error("simulated interruption");
    return texts.map((text) => mockVector(text));
  }
}

class FailingRerankProvider extends MockProvider {
  override chatCalls = 0;
  private markStarted!: () => void;
  private readonly releases: Array<() => void> = [];
  readonly started = new Promise<void>((resolve) => {
    this.markStarted = resolve;
  });

  override async chat(): Promise<string> {
    this.chatCalls++;
    if (this.chatCalls === 4) {
      this.markStarted();
      throw new Error("simulated rerank failure");
    }
    if (this.chatCalls > 4) return "yes";
    return new Promise((resolve) => this.releases.push(() => resolve("yes")));
  }

  release(): void {
    for (const release of this.releases) release();
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

function replaceChunksWithManualVectors(
  rows: Array<{ docId: number; seq: number; text: string; value: number }>,
): void {
  db.exec("DELETE FROM chunks_vec");
  db.exec("DELETE FROM chunks");
  const insertChunk = db.prepare(
    `INSERT INTO chunks (document_id, seq, text, start_offset, embedded_at)
     VALUES (?, ?, ?, 0, datetime('now'))`,
  );
  const insertVector = db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)");
  for (const row of rows) {
    const result = insertChunk.run(row.docId, row.seq, row.text);
    const vector = new Float32Array([0, 0, 0, row.value]);
    insertVector.run(
      Number(result.lastInsertRowid),
      new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength),
    );
  }
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

  test("tag filters treat SQL wildcard characters literally", () => {
    const literal = createDocument(db, {
      title: "リテラル分類の検索",
      content: "データベース検索の本文。",
      bucket: "main",
      tags: ["分類_甲/子", "進捗%完了/子"],
    });
    createDocument(db, {
      title: "類似分類の検索",
      content: "データベース検索の本文。",
      bucket: "main",
      tags: ["分類乙甲/子", "進捗済完了/子"],
    });

    expect(
      keywordSearch(db, "trigram", "データベース", { tag: "分類_甲" }).map((hit) => hit.key),
    ).toEqual([literal.key]);
    expect(
      keywordSearch(db, "trigram", "データベース", { tag: "進捗%完了" }).map((hit) => hit.key),
    ).toEqual([literal.key]);
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
    recreateVecIfModelChanged(db, config);
    expect(backfillEmbeddings(db, mock, config)).rejects.toThrow(/embedding_dimensions/);
  });

  test("refuses model drift until an explicit full rebuild", async () => {
    seedDocs();
    await backfillEmbeddings(db, mock, config);
    const storedModel = getMeta(db, "embedding_model");
    const vectorCount = db.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get() as { n: number };

    config.llm.models.embedding = "別の埋め込みモデル";
    const callsBefore = mock.embedCalls;
    await expect(backfillEmbeddings(db, mock, config)).rejects.toThrow(/doctor --fix/);
    await expect(backfillEmbeddings(db, mock, config, { all: true })).rejects.toThrow(
      /doctor --fix/,
    );
    await expect(vectorSearch(db, mock, config, "猫", {})).rejects.toThrow(/doctor --fix/);
    expect(mock.embedCalls).toBe(callsBefore);
    expect(getMeta(db, "embedding_model")).toBe(storedModel);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get()).toEqual(vectorCount);

    expect(recreateVecIfModelChanged(db, config)?.action).toBe("vec-recreate");
    await backfillEmbeddings(db, mock, config);
    expect(getMeta(db, "embedding_model")).toBe("別の埋め込みモデル");
    expect(getMeta(db, "embedding_dimensions")).toBe("4");
    expect(pendingChunkCount(db)).toBe(0);
  });

  test("an explicit full rebuild handles a dimension change", async () => {
    seedDocs();
    await backfillEmbeddings(db, mock, config);
    config.llm.models.embedding = "8次元モデル";
    config.llm.models.embedding_dimensions = 8;

    expect(recreateVecIfModelChanged(db, config)?.action).toBe("vec-recreate");
    await backfillEmbeddings(db, new EightDimensionProvider(), config);
    expect(getMeta(db, "embedding_model")).toBe("8次元モデル");
    expect(getMeta(db, "embedding_dimensions")).toBe("8");
    expect(pendingChunkCount(db)).toBe(0);
  });

  test("does not attach a stale vector when a chunk changes during provider await", async () => {
    const doc = createDocument(db, {
      title: "編集中のメモ",
      content: "変更前の本文。",
      bucket: "main",
    });
    const provider = new DeferredEmbedProvider();
    const progress: Array<[number, number]> = [];
    const running = backfillEmbeddings(db, provider, config, {
      onProgress: (done, total) => progress.push([done, total]),
    });
    await provider.started;
    updateDocument(db, doc.id, { content: "変更後の本文。" });
    provider.release();
    const result = await running;

    expect(result.embedded).toBe(0);
    expect(progress.at(-1)).toEqual([1, 1]);
    expect(pendingChunkCount(db)).toBeGreaterThan(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get()).toEqual({ n: 0 });
  });

  test("does not leave an orphan vector when a document is deleted during provider await", async () => {
    const doc = createDocument(db, { title: "削除中のメモ", content: "本文。", bucket: "main" });
    const provider = new DeferredEmbedProvider();
    const running = backfillEmbeddings(db, provider, config);
    await provider.started;
    deleteDocument(db, doc.id);
    provider.release();
    const result = await running;

    expect(result.embedded).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get()).toEqual({ n: 0 });
  });

  test("auto-backfill warns when a concurrent edit leaves a chunk pending", async () => {
    const doc = createDocument(db, {
      title: "自動補完中",
      content: "変更前の本文。",
      bucket: "main",
    });
    const provider = new DeferredEmbedProvider();
    const running = ensureEmbeddings(db, provider, config);
    await provider.started;
    updateDocument(db, doc.id, { content: "変更後の本文。" });
    provider.release();

    expect(await running).toContain("not embedded yet");
    expect(pendingChunkCount(db)).toBe(1);
  });

  test("rejects a query vector when identity changes during provider await", async () => {
    seedDocs();
    await backfillEmbeddings(db, mock, config);
    const provider = new DeferredEmbedProvider();
    const running = vectorSearch(db, provider, config, "猫", {});
    await provider.started;
    config.llm.models.embedding = "待機中に選ばれた別モデル";
    resetEmbeddingIndex(db, config);
    provider.release();

    await expect(running).rejects.toThrow(/embedding identity mismatch/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get()).toEqual({ n: 0 });
  });

  test("the full reset rolls back all statements when one reset statement fails", async () => {
    seedDocs();
    await backfillEmbeddings(db, mock, config);
    const before = {
      vectors: db.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get(),
      pending: pendingChunkCount(db),
      model: getMeta(db, "embedding_model"),
      dimensions: getMeta(db, "embedding_dimensions"),
    };
    db.exec(`CREATE TRIGGER reject_embedding_reset
      BEFORE UPDATE OF embedded_at ON chunks
      BEGIN SELECT RAISE(ABORT, 'simulated reset failure'); END`);

    await expect(backfillEmbeddings(db, mock, config, { all: true })).rejects.toThrow(
      /simulated reset failure/,
    );
    expect({
      vectors: db.prepare("SELECT COUNT(*) AS n FROM chunks_vec").get(),
      pending: pendingChunkCount(db),
      model: getMeta(db, "embedding_model"),
      dimensions: getMeta(db, "embedding_dimensions"),
    }).toEqual(before);
  });

  test("commits bounded batches and resumes after an interruption", async () => {
    for (let i = 0; i < 40; i++) {
      createDocument(db, {
        title: `再開確認 ${i}`,
        content: `日本語の埋め込み対象 ${i}。`,
        bucket: "main",
      });
    }
    const interrupted = new InterruptedProvider();
    await expect(backfillEmbeddings(db, interrupted, config)).rejects.toThrow(
      /simulated interruption/,
    );
    expect(interrupted.embedBatchSizes).toEqual([16, 16]);
    expect(pendingChunkCount(db)).toBe(24);

    const resumed = new MockProvider();
    const result = await backfillEmbeddings(db, resumed, config);
    expect(result).toEqual({ embedded: 24, total: 24 });
    expect(Math.max(...resumed.embedBatchSizes)).toBeLessThanOrEqual(16);
    expect(pendingChunkCount(db)).toBe(0);
  });

  test("expands KNN candidates until a bucket-filtered document is found", async () => {
    createBucket(db, "work");
    const distractors = Array.from({ length: 45 }, (_, i) =>
      createDocument(db, {
        title: `別バケットの候補 ${i}`,
        content: `近い候補 ${i}。`,
        bucket: "main",
      }),
    );
    const target = createDocument(db, {
      title: "対象バケットの候補",
      content: "遠くても絞り込み対象。",
      bucket: "work",
    });
    replaceChunksWithManualVectors([
      ...distractors.map((doc, i) => ({
        docId: doc.id,
        seq: 0,
        text: `# ${doc.title}\n\n近い候補。`,
        value: 1 + i / 100,
      })),
      { docId: target.id, seq: 0, text: `# ${target.title}\n\n対象。`, value: 10 },
    ]);

    const hits = await vectorSearch(db, mock, config, "検索対象", {
      bucket: "work",
      limit: 1,
    });
    expect(hits.map((hit) => hit.title)).toEqual(["対象バケットの候補"]);
  });

  test("applies a hierarchical parent-tag filter before KNN selection", async () => {
    const distractors = Array.from({ length: 45 }, (_, i) =>
      createDocument(db, {
        title: `別タグの候補 ${i}`,
        content: `近い候補 ${i}。`,
        bucket: "main",
        tags: ["雑記"],
      }),
    );
    const target = createDocument(db, {
      title: "子タグの対象候補",
      content: "遠くても親タグの対象。",
      bucket: "main",
      tags: ["技術/検索"],
    });
    replaceChunksWithManualVectors([
      ...distractors.map((doc, i) => ({
        docId: doc.id,
        seq: 0,
        text: `# ${doc.title}\n\n近い候補。`,
        value: 1 + i / 100,
      })),
      { docId: target.id, seq: 0, text: `# ${target.title}\n\n対象。`, value: 10 },
    ]);

    const hits = await vectorSearch(db, mock, config, "検索対象", { tag: "技術", limit: 1 });
    expect(hits.map((hit) => hit.title)).toEqual(["子タグの対象候補"]);
  });

  test("vector tag filters treat SQL wildcard characters literally", async () => {
    const target = createDocument(db, {
      title: "リテラルタグ対象",
      content: "検索対象の本文。",
      bucket: "main",
      tags: ["技術_検索/子"],
    });
    const lookalike = createDocument(db, {
      title: "類似タグ対象外",
      content: "検索対象の本文。",
      bucket: "main",
      tags: ["技術甲検索/子"],
    });
    replaceChunksWithManualVectors([
      { docId: lookalike.id, seq: 0, text: "# 類似タグ対象外\n\n近い候補。", value: 1 },
      { docId: target.id, seq: 0, text: "# リテラルタグ対象\n\n遠い候補。", value: 10 },
    ]);

    const hits = await vectorSearch(db, mock, config, "検索対象", {
      tag: "技術_検索",
      limit: 1,
    });
    expect(hits.map((hit) => hit.key)).toEqual([target.key]);
  });

  test("expands KNN candidates when many chunks from one document consume the first window", async () => {
    const dominant = createDocument(db, {
      title: "多数チャンクの文書",
      content: "近い断片が多い。",
      bucket: "main",
    });
    const target = createDocument(db, {
      title: "次の文書",
      content: "別の検索結果。",
      bucket: "main",
    });
    replaceChunksWithManualVectors([
      ...Array.from({ length: 45 }, (_, i) => ({
        docId: dominant.id,
        seq: i,
        text: `# 多数チャンクの文書\n\n断片 ${i}。`,
        value: 1 + i / 100,
      })),
      { docId: target.id, seq: 0, text: "# 次の文書\n\n別の結果。", value: 10 },
    ]);

    const hits = await vectorSearch(db, mock, config, "検索対象", { limit: 2 });
    expect(hits.map((hit) => hit.title)).toEqual(["多数チャンクの文書", "次の文書"]);
  });
});

describe("rerankCandidates", () => {
  test("waits for in-flight workers and stops assigning work after one fails", async () => {
    const provider = new FailingRerankProvider();
    const candidates = Array.from({ length: 8 }, (_, i) => ({
      docId: i + 1,
      text: `再評価候補 ${i}`,
    }));
    const running = rerankCandidates(db, provider, config, "検索条件", candidates);
    let settled = false;
    void running
      .finally(() => {
        settled = true;
      })
      .catch(() => {});

    await provider.started;
    await Bun.sleep(0);
    const settledBeforeRelease = settled;
    provider.release();
    await expect(running).rejects.toThrow(/simulated rerank failure/);
    await Bun.sleep(0);

    expect(settledBeforeRelease).toBe(false);
    expect(provider.chatCalls).toBe(4);
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
