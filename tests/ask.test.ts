import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig, type KuraConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import { createDocument, updateDocument } from "../src/core/documents";
import type { LLMProvider, Message } from "../src/core/llm/provider";
import { setProviderForTests } from "../src/core/llm/provider";
import { askQuestion } from "../src/core/search/ask";

/**
 * Mock provider for kura ask (testing.md R2 — never a live server):
 * - embed: 4-dimensional keyword-presence vectors
 * - chat: rerank prompts answer yes/no; ask prompts return a canned cited answer
 */
class AskMockProvider implements LLMProvider {
  name = "ollama" as const;
  askCalls = 0;
  failAsk = false;

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async hasModel(): Promise<boolean> {
    return true;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(4);
      if (t.includes("猫")) v[0] = 1;
      if (t.includes("犬")) v[1] = 1;
      v[3] = 0.1;
      return v;
    });
  }

  async chat(messages: Message[]): Promise<string> {
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (user.includes("<Query>:")) {
      // rerank
      return "yes";
    }
    this.askCalls++;
    if (this.failAsk) throw new Error("generation model exploded");
    expect(user).toContain("資料:");
    expect(user).toContain("[1]");
    return "<think>考え中</think>猫には毎日の餌やりと猫トイレの掃除が必要です [1]";
  }
}

let db: Database;
let config: KuraConfig;
let mock: AskMockProvider;

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
  config = defaultConfig();
  config.llm.models.embedding_dimensions = 4;
  mock = new AskMockProvider();
  setProviderForTests(mock);
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
});

afterEach(() => {
  setProviderForTests(undefined);
  db.close();
});

describe("askQuestion", () => {
  test("answers from hybrid hits with numbered sources; think blocks are stripped", async () => {
    const outcome = await askQuestion(db, "trigram", config, "猫の世話で大事なことは？");
    expect(outcome.answer).toBe("猫には毎日の餌やりと猫トイレの掃除が必要です [1]");
    expect(outcome.answer).not.toContain("<think>");
    expect(outcome.sources.length).toBeGreaterThan(0);
    expect(outcome.sources[0]?.title).toBe("猫の飼い方");
  });

  test("caches the answer and invalidates when a source document changes", async () => {
    await askQuestion(db, "trigram", config, "猫の世話で大事なことは？");
    await askQuestion(db, "trigram", config, "猫の世話で大事なことは？");
    expect(mock.askCalls).toBe(1);

    const catDoc = db.prepare("SELECT id FROM documents WHERE title = ?").get("猫の飼い方") as {
      id: number;
    };
    updateDocument(db, catDoc.id, { content: "猫は水分補給も大切。 #ペット/猫" });
    await askQuestion(db, "trigram", config, "猫の世話で大事なことは？");
    expect(mock.askCalls).toBe(2);
  });

  test("degrades to plain hits when no provider is available", async () => {
    setProviderForTests(null);
    // A query that keyword search alone can satisfy (the exact phrase appears in the body)
    const outcome = await askQuestion(db, "trigram", config, "猫トイレの掃除");
    expect(outcome.answer).toBeNull();
    expect(outcome.sources).toEqual([]);
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.warnings.some((w) => w.includes("showing search results only"))).toBe(true);
  });

  test("degrades to plain hits when generation fails", async () => {
    mock.failAsk = true;
    const outcome = await askQuestion(db, "trigram", config, "猫の世話で大事なことは？");
    expect(outcome.answer).toBeNull();
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.warnings.some((w) => w.includes("answer generation failed"))).toBe(true);
  });

  test("no hits means no answer and no LLM call", async () => {
    // Provider absent so vector KNN cannot pull in nearest-neighbour noise
    setProviderForTests(null);
    const outcome = await askQuestion(db, "trigram", config, "存在しないトピックXYZW");
    expect(outcome.answer).toBeNull();
    expect(outcome.hits).toEqual([]);
    expect(mock.askCalls).toBe(0);
  });
});
