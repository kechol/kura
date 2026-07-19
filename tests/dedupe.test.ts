import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { defaultConfig, type KuraConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import {
  exactDuplicates,
  judgeDuplicatePair,
  mergeDuplicate,
  nearDuplicates,
} from "../src/core/dedupe";
import {
  createDocument,
  getDocumentById,
  getDocumentByKey,
} from "../src/core/documents";
import { appendRelatedLinks, suggestLinksForDocument } from "../src/core/linking";
import { outlinks } from "../src/core/links";
import type { LLMProvider, Message } from "../src/core/llm/provider";
import { setProviderForTests } from "../src/core/llm/provider";
import { backfillEmbeddings } from "../src/core/search/vector";
import { suggestTitleForDocument } from "../src/core/titling";

/**
 * Deterministic mock (testing.md R2). Embeddings are keyword vectors; the dedupe
 * verdict (dedupe.ts DUPE_PROMPT, 重複) always keeps side "a"; the relatedness
 * verdict (linking.ts LINK_PROMPT, 関連付け) answers yes; the title verdict
 * (titling.ts TITLE_PROMPT, タイトル) proposes a fixed title. `chatCalls` proves
 * the symmetric verdict cache.
 */
class DedupeMockProvider implements LLMProvider {
  name = "ollama" as const;
  chatCalls = 0;
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async hasModel(): Promise<boolean> {
    return true;
  }
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const v = new Float32Array(4);
      if (t.includes("牛乳")) v[0] = 1;
      else if (t.includes("散歩")) v[1] = 1;
      else v[3] = 1;
      return v;
    });
  }
  async chat(messages: Message[]): Promise<string> {
    this.chatCalls++;
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    if (system.includes("重複")) {
      return '{"duplicate": true, "keep": "a", "reason": "ほぼ同一"}';
    }
    if (system.includes("関連付け")) {
      return "yes";
    }
    if (system.includes("タイトル")) {
      return '{"title": "牛乳と猫の注意点", "reason": "内容に即したタイトル"}';
    }
    return "no";
  }
}

let db: Database;
let config: KuraConfig;
let mock: DedupeMockProvider;

beforeEach(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
  config = defaultConfig();
  config.llm.models.embedding_dimensions = 4;
  mock = new DedupeMockProvider();
  setProviderForTests(mock);
});

afterEach(() => {
  setProviderForTests(undefined);
  db.close();
});

describe("exactDuplicates (core)", () => {
  test("finds byte-identical documents (different titles) and excludes non-duplicates", () => {
    const a = createDocument(db, { title: "猫の飼い方", content: "猫は牛乳を飲めない。", bucket: "main" });
    const b = createDocument(db, { title: "ネコのケア", content: "猫は牛乳を飲めない。", bucket: "main" });
    createDocument(db, { title: "別の話題", content: "犬の散歩について。", bucket: "main" });

    const dupKeys = exactDuplicates(db, a).map((d) => d.key);
    expect(dupKeys).toEqual([b.key]);
  });
});

describe("nearDuplicates (core)", () => {
  test("near vectors surface a candidate carrying the LLM verdict", async () => {
    const a = createDocument(db, {
      title: "猫と牛乳A",
      content: "猫に牛乳を与えるべきではない。お腹を壊す。",
      bucket: "main",
    });
    const b = createDocument(db, {
      title: "猫と牛乳B",
      content: "猫へ牛乳をあげるのは避けたい。消化に良くない。",
      bucket: "main",
    });
    await backfillEmbeddings(db, mock, config);

    const { candidates, warnings } = await nearDuplicates(db, mock, config, a);
    const cand = candidates.find((c) => c.doc.key === b.key);
    expect(cand).toBeTruthy();
    expect(cand?.exact).toBe(false);
    expect(cand?.verdict?.duplicate).toBe(true);
    expect(warnings).toEqual([]);
  });

  test("no provider yields no candidates and a warning (exact check still runs elsewhere)", async () => {
    const a = createDocument(db, { title: "牛乳メモ", content: "猫と牛乳の話。", bucket: "main" });
    const { candidates, warnings } = await nearDuplicates(db, null, config, a);
    expect(candidates).toEqual([]);
    expect(warnings.some((w) => w.includes("no LLM provider"))).toBe(true);
  });
});

describe("judgeDuplicatePair (core)", () => {
  test("symmetric cache: (A,B) then (B,A) reuses the verdict and keeps the same survivor", async () => {
    const a = createDocument(db, {
      title: "牛乳の記事（詳細版）",
      content: "猫と牛乳について詳しく説明した長い記事。",
      bucket: "main",
    });
    const b = createDocument(db, {
      title: "牛乳メモ",
      content: "猫と牛乳の短いメモ。",
      bucket: "main",
    });

    const v1 = await judgeDuplicatePair(db, mock, config, a, b);
    expect(mock.chatCalls).toBe(1);
    expect(v1?.duplicate).toBe(true);
    const survivor1 = v1?.keep === "current" ? a.key : b.key;

    // Reversed order hits the unordered content-hash cache — no second chat call
    const v2 = await judgeDuplicatePair(db, mock, config, b, a);
    expect(mock.chatCalls).toBe(1);
    const survivor2 = v2?.keep === "current" ? b.key : a.key;

    // The surviving document is the same regardless of argument order
    expect(survivor2).toBe(survivor1);
    expect(survivor1).toBe(a.key);
  });
});

describe("mergeDuplicate (core)", () => {
  test("survivor gains the duplicate's title alias + tags (auto), duplicate is deleted, and referring links re-resolve", () => {
    const survivor = createDocument(db, { title: "本命ノート", content: "充実した本文。", bucket: "main" });
    const dup = createDocument(db, { title: "重複ノート", content: "簡易な本文。 #重要", bucket: "main" });
    const third = createDocument(db, { title: "参照元", content: "[[重複ノート]] を参照。", bucket: "main" });

    // Before the merge the wiki link resolves to the duplicate
    expect(outlinks(db, third.id)[0]?.target?.key).toBe(dup.key);

    const { aliasesAdded, tagsAdded } = mergeDuplicate(db, survivor.id, dup.id);
    expect(aliasesAdded).toContain("重複ノート");
    expect(tagsAdded).toContain("重要");

    // The duplicate is gone
    expect(getDocumentByKey(db, dup.key)).toBeNull();

    // Survivor carries the alias and the tag
    const surv = getDocumentById(db, survivor.id);
    expect(surv.aliases).toContain("重複ノート");
    expect(surv.tags).toContain("重要");
    // The carried tag is attached with source 'auto' (no core accessor exposes source)
    const src = db
      .prepare(
        `SELECT dt.source FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
         WHERE dt.document_id = ? AND t.path = ?`,
      )
      .get(surv.id, "重要") as { source: string };
    expect(src.source).toBe("auto");

    // Alias self-healing re-points the third document's [[重複ノート]] link at the survivor
    expect(outlinks(db, getDocumentById(db, third.id).id)[0]?.target?.key).toBe(survivor.key);
  });
});

// Titling + linking core coverage lives here (task item 2). appendRelatedLinks is
// pure; suggestTitleForDocument / suggestLinksForDocument exercise the degraded path.
describe("appendRelatedLinks (core)", () => {
  test("creates a ## 関連 section with bullets", () => {
    const out = appendRelatedLinks("本文の段落。", ["設計メモ", "検索"]);
    expect(out).toBe("本文の段落。\n\n## 関連\n- [[設計メモ]]\n- [[検索]]\n");
  });

  test("appends to an existing section without duplicating bullets", () => {
    const input = "本文。\n\n## 関連\n- [[既存]]\n";
    const out = appendRelatedLinks(input, ["既存", "新規"]);
    expect(out).toBe("本文。\n\n## 関連\n- [[既存]]\n- [[新規]]\n");
    expect(out.match(/\[\[既存\]\]/g)?.length).toBe(1);
  });

  test("preserves content byte-for-byte when there is nothing to add", () => {
    const input = "本文。\n\n## 関連\n- [[既存]]\n";
    expect(appendRelatedLinks(input, ["既存"])).toBe(input);
    expect(appendRelatedLinks(input, [])).toBe(input);
  });
});

describe("suggestTitleForDocument (core)", () => {
  test("degrades to a warning with no provider", async () => {
    const doc = createDocument(db, { title: "メモ", content: "本文。", bucket: "main" });
    const { suggestion, warnings } = await suggestTitleForDocument(db, null, config, doc);
    expect(suggestion).toBeNull();
    expect(warnings.some((w) => w.includes("no LLM provider"))).toBe(true);
  });

  test("returns no suggestion (no warning) when the model echoes the current title", async () => {
    const echo: LLMProvider = {
      name: "ollama",
      isAvailable: async () => true,
      hasModel: async () => true,
      embed: async (texts) => texts.map(() => new Float32Array(4)),
      chat: async () => '{"title": "既存タイトル", "reason": "変更不要"}',
    };
    const doc = createDocument(db, { title: "既存タイトル", content: "本文。", bucket: "main" });
    const { suggestion, warnings } = await suggestTitleForDocument(db, echo, config, doc);
    expect(suggestion).toBeNull();
    expect(warnings).toEqual([]);
  });
});

describe("suggestLinksForDocument (core)", () => {
  test("no provider falls back to unjudged keyword neighbours with a warning", async () => {
    createDocument(db, { title: "牛乳と猫", content: "猫に牛乳を与える是非。", bucket: "main" });
    const doc = createDocument(db, {
      title: "牛乳の与え方",
      content: "牛乳を猫にどう与えるか。",
      bucket: "main",
    });
    const { suggestions, warnings } = await suggestLinksForDocument(db, "trigram", null, config, doc);
    expect(warnings.some((w) => w.includes("no LLM provider"))).toBe(true);
    // keyword neighbours are returned unjudged (source 'keyword'), self excluded
    expect(suggestions.every((s) => s.source === "keyword")).toBe(true);
    expect(suggestions.every((s) => s.doc.key !== doc.key)).toBe(true);
  });
});
