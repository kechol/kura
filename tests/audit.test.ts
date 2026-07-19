import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findContradictions } from "../src/core/audit";
import { defaultConfig, type KuraConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import { createDocument } from "../src/core/documents";
import type { LLMProvider, Message } from "../src/core/llm/provider";
import { setProviderForTests } from "../src/core/llm/provider";
import { backfillEmbeddings } from "../src/core/search/vector";

/**
 * Deterministic mock (testing.md R2): embeddings by keyword presence; the
 * judge answers yes only when the pair contains both sides of the 牛乳 claim.
 */
class AuditMockProvider implements LLMProvider {
  name = "ollama" as const;
  judgeCalls = 0;

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
      if (t.includes("散歩")) v[1] = 1;
      if (v[0] === 0 && v[1] === 0) v[3] = 1;
      return v;
    });
  }

  async chat(messages: Message[]): Promise<string> {
    this.judgeCalls++;
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    return user.includes("与えてよい") && user.includes("禁物") ? "yes" : "no";
  }
}

let db: Database;
let config: KuraConfig;
let mock: AuditMockProvider;

beforeEach(async () => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
  config = defaultConfig();
  config.llm.models.embedding_dimensions = 4;
  mock = new AuditMockProvider();
  setProviderForTests(mock);

  createDocument(db, {
    title: "猫と牛乳（推奨）",
    content: "猫に牛乳を与えてよい。毎日あげよう。",
    bucket: "main",
  });
  createDocument(db, {
    title: "猫と牛乳（注意）",
    content: "猫に牛乳は禁物。お腹を壊すことがある。",
    bucket: "main",
  });
  createDocument(db, {
    title: "犬の運動",
    content: "犬の散歩は毎日必要。",
    bucket: "main",
  });
  await backfillEmbeddings(db, mock, config);
});

afterEach(() => {
  setProviderForTests(undefined);
  db.close();
});

describe("findContradictions", () => {
  test("flags the contradictory pair and only that pair", async () => {
    const outcome = await findContradictions(db, mock, config);
    expect(outcome.examinedPairs).toBeGreaterThan(0);

    const flagged = outcome.pairs.filter((p) => p.contradictory);
    expect(flagged.length).toBe(1);
    const titles = [flagged[0]!.a.title, flagged[0]!.b.title].sort();
    expect(titles).toEqual(["猫と牛乳（推奨）", "猫と牛乳（注意）"]);
    expect(flagged[0]!.similarity).toBeGreaterThan(0.5);
  });

  test("verdicts are cached across runs", async () => {
    await findContradictions(db, mock, config);
    const calls = mock.judgeCalls;
    expect(calls).toBeGreaterThan(0);
    await findContradictions(db, mock, config);
    expect(mock.judgeCalls).toBe(calls);
  });

  test("limit caps the judged pairs", async () => {
    const outcome = await findContradictions(db, mock, config, { limit: 1 });
    expect(outcome.examinedPairs).toBe(1);
    // The closest pair is the two 牛乳 documents (identical vectors)
    expect(outcome.pairs[0]?.contradictory).toBe(true);
  });
});

describe("kura audit CLI (degraded)", () => {
  const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

  test("exits 4 when no provider is configured", async () => {
    const home = mkdtempSync(join(tmpdir(), "kura-audit-cli-"));
    const env = { KURA_HOME: home, KURA_DB: join(home, "kura.db") };
    try {
      const init = Bun.spawn(["bun", "run", CLI, "init", "--no-download"], {
        env: { ...process.env, NO_COLOR: "1", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await init.exited).toBe(0);
      // Pin the provider off so the test never talks to a local Ollama (testing.md R2)
      writeFileSync(join(home, "config.toml"), '[llm]\nprovider = "none"\n');

      const proc = Bun.spawn(["bun", "run", CLI, "audit"], {
        env: { ...process.env, NO_COLOR: "1", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      expect(code).toBe(4);
      expect(stderr).toContain("LLM");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 30_000);
});
