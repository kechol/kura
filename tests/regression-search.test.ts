import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, type KuraConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import { createDocument, resolveDoc } from "../src/core/documents";
import { parseFrontmatter } from "../src/core/frontmatter";
import { backlinks } from "../src/core/links";
import { setProviderForTests } from "../src/core/llm/provider";
import { hybridQuery } from "../src/core/search/hybrid";
import { keywordSearch } from "../src/core/search/keyword";
import type { SearchHit } from "../src/core/search/types";

/**
 * 日本語検索の回帰テスト（SPEC §14）。
 * tests/fixtures/docs の日本語ドキュメント 30 件（技術メモ・議事録・クリップ記事）を
 * trigram トークナイザーの :memory: DB へ投入し、BM25 順位・スニペット・フィルタを検証する。
 * trigram の制約により、クエリは必ず 3 文字以上の語彙を使うこと。
 */

const FIXTURES_DIR = join(import.meta.dir, "fixtures", "docs");
const FIXTURE_COUNT = 30;

let db: Database;
let config: KuraConfig;

function rankOf(hits: SearchHit[], title: string): number {
  return hits.findIndex((h) => h.title === title);
}

beforeAll(() => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
  config = defaultConfig();
  config.llm.models.embedding_dimensions = 4;
  // 実プロバイダの検出を無効化し、hybridQuery の劣化動作を決定的にする
  setProviderForTests(null);

  const files = readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort();
  if (files.length !== FIXTURE_COUNT) {
    throw new Error(`fixtures/docs には ${FIXTURE_COUNT} 件必要です（現在 ${files.length} 件）`);
  }
  for (const file of files) {
    const raw = readFileSync(join(FIXTURES_DIR, file), "utf8");
    const { fm, body } = parseFrontmatter(raw);
    createDocument(db, {
      title: fm?.title ?? file,
      content: body,
      bucket: fm?.bucket ?? "main",
      tags: fm?.tags,
      sourceUrl: fm?.source_url ?? null,
    });
  }
});

afterAll(() => {
  setProviderForTests(undefined);
  db.close();
});

describe("fixture 投入", () => {
  test("30 件すべて投入され FTS 行数が一致する", () => {
    const docs = db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number };
    const fts = db.prepare("SELECT COUNT(*) AS n FROM documents_fts").get() as { n: number };
    expect(docs.n).toBe(FIXTURE_COUNT);
    expect(fts.n).toBe(FIXTURE_COUNT);
  });
});

describe("BM25 順位: タイトル一致 > 本文のみ一致", () => {
  const cases = [
    {
      query: "トランザクション",
      titleDoc: "SQLite のトランザクション設計",
      bodyDoc: "WALモードの仕組み",
    },
    {
      query: "マイグレーション",
      titleDoc: "データベースマイグレーション手順",
      bodyDoc: "Bunランタイム移行メモ",
    },
    {
      query: "形態素解析",
      titleDoc: "日本語形態素解析の基礎",
      bodyDoc: "クリップ: 日本語トークナイズ事情",
    },
  ];
  for (const c of cases) {
    test(`「${c.query}」でタイトル一致の ${c.titleDoc} が最上位`, () => {
      const hits = keywordSearch(db, "trigram", c.query, { limit: 30 });
      expect(hits.length).toBeGreaterThanOrEqual(2);
      expect(hits[0]?.title).toBe(c.titleDoc);
      expect(rankOf(hits, c.bodyDoc)).toBeGreaterThan(0);
    });
  }
});

describe("スニペット", () => {
  test("マッチ語が ** で囲まれる", () => {
    const hits = keywordSearch(db, "trigram", "形態素解析", {});
    expect(hits[0]?.snippet).toContain("**形態素解析**");
  });

  test("長い本文は … で省略される", () => {
    const hits = keywordSearch(db, "trigram", "トランザクション", {});
    expect(hits[0]?.snippet).toContain("**トランザクション**");
    expect(hits[0]?.snippet).toContain("…");
  });
});

describe("タグ絞り込み", () => {
  test("tag オプションで階層タグの配下だけに絞り込める", () => {
    const minutes = keywordSearch(db, "trigram", "全文検索", { tag: "minutes" });
    expect(minutes.length).toBe(1);
    expect(minutes[0]?.title).toBe("検索機能設計レビュー議事録");

    const tech = keywordSearch(db, "trigram", "全文検索", { tag: "tech" });
    expect(tech.map((h) => h.title).sort()).toEqual([
      "FTS5の使い方メモ",
      "全文検索エンジンの比較",
      "検索トークナイザーの選定",
    ]);

    const clips = keywordSearch(db, "trigram", "全文検索", { tag: "clips" });
    expect(clips.length).toBe(2);
  });
});

describe("--all（AND）検索", () => {
  test("AND は OR より件数が絞り込まれる", () => {
    const or = keywordSearch(db, "trigram", "全文検索 形態素解析", { limit: 30 });
    const and = keywordSearch(db, "trigram", "全文検索 形態素解析", { all: true, limit: 30 });
    expect(or.length).toBe(7);
    expect(and.length).toBe(2);
    expect(and.length).toBeLessThan(or.length);
    expect(and.map((h) => h.title).sort()).toEqual([
      "クリップ: 日本語トークナイズ事情",
      "検索トークナイザーの選定",
    ]);
  });
});

describe("[[リンク]] 解決", () => {
  test("fixture 間の [[タイトル]] リンクが backlinks として解決される", () => {
    const engines = resolveDoc(db, "全文検索エンジンの比較");
    const engineRefs = backlinks(db, engines.id).map((d) => d.title);
    expect(engineRefs.length).toBeGreaterThanOrEqual(1);
    expect(engineRefs).toContain("FTS5の使い方メモ");
    expect(engineRefs).toContain("検索機能設計レビュー議事録");

    const tx = resolveDoc(db, "SQLite のトランザクション設計");
    const txRefs = backlinks(db, tx.id).map((d) => d.title);
    expect(txRefs).toContain("WALモードの仕組み");
    expect(txRefs).toContain("データベースマイグレーション手順");
  });
});

describe("hybridQuery 劣化動作", () => {
  test("プロバイダ不在でも警告付きでキーワード検索の結果を返す", async () => {
    const outcome = await hybridQuery(db, "trigram", config, "トランザクション", { limit: 5 });
    expect(outcome.usedVector).toBe(false);
    expect(outcome.usedRerank).toBe(false);
    expect(outcome.warnings.length).toBeGreaterThan(0);
    expect(outcome.hits.length).toBeGreaterThan(0);
    expect(outcome.hits[0]?.title).toBe("SQLite のトランザクション設計");
    expect(outcome.hits[0]?.source).toBe("hybrid");
  });
});

describe("レイテンシ smoke", () => {
  test("keywordSearch 1 回が 300ms 未満で完了する", () => {
    const start = performance.now();
    keywordSearch(db, "trigram", "全文検索", { limit: 20 });
    expect(performance.now() - start).toBeLessThan(300);
  });
});
