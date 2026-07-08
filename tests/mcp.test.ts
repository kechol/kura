import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { defaultConfig } from "../src/core/config";
import { openDatabase } from "../src/core/db";
import { createDocument } from "../src/core/documents";
import { setProviderForTests } from "../src/core/llm/provider";
import { createMcpServer } from "../src/server/mcp";

let db: Database;
let client: Client;

function contentText(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }> };
  return r.content[0]?.text ?? "";
}

beforeEach(async () => {
  db = openDatabase({ path: ":memory:", vaporettoPath: null, dimensions: 4 }).db;
  // 検索系はプロバイダなしの劣化動作で決定的にテストする
  setProviderForTests(null);

  createDocument(db, {
    title: "SQLite の WAL モード",
    content: "WAL は書き込みをブロックしない。[[トランザクション設計]] を参照。 #tech/db/sqlite",
    bucket: "main",
  });
  createDocument(db, {
    title: "トランザクション設計",
    content: "トランザクションの分離レベルについて。 #tech/db",
    bucket: "main",
  });

  const server = createMcpServer({ db, tokenizer: "trigram", config: defaultConfig() });
  client = new Client({ name: "test-client", version: "0.0.1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  setProviderForTests(undefined);
  db.close();
});

describe("kura mcp server", () => {
  test("8 ツールが公開され、description にガイダンスがある", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "kura_add",
      "kura_get",
      "kura_list_tags",
      "kura_query",
      "kura_related",
      "kura_search",
      "kura_status",
      "kura_update",
    ]);
    const query = tools.find((t) => t.name === "kura_query");
    expect(query?.description).toContain("kura_get");
  });

  test("kura_search → kura_get のフロー（access_count 更新込み）", async () => {
    const search = await client.callTool({
      name: "kura_search",
      arguments: { query: "トランザクション" },
    });
    const md = contentText(search);
    expect(md).toContain("トランザクション設計");
    const key = md.match(/key: `([0-9a-f]{8})`/)?.[1];
    expect(key).toBeTruthy();

    const get = await client.callTool({ name: "kura_get", arguments: { key: key! } });
    expect(contentText(get)).toContain("分離レベル");

    const row = db.prepare("SELECT access_count FROM documents WHERE doc_key = ?").get(key!) as {
      access_count: number;
    };
    expect(row.access_count).toBe(1);
  });

  test("kura_query は劣化動作でも応答する（警告付き）", async () => {
    const result = await client.callTool({
      name: "kura_query",
      arguments: { query: "トランザクション", limit: 5 },
    });
    const md = contentText(result);
    expect(md).toContain("⚠");
    expect(md).toContain("トランザクション設計");
  });

  test("kura_add / kura_update / kura_list_tags", async () => {
    const add = await client.callTool({
      name: "kura_add",
      arguments: {
        title: "Bun のテスト",
        content: "bun test の使い方。 #tech/bun",
        tags: ["メモ"],
      },
    });
    const key = contentText(add).match(/key: `([0-9a-f]{8})`/)?.[1];
    expect(key).toBeTruthy();

    const update = await client.callTool({
      name: "kura_update",
      arguments: { key: key!, content: "更新済み本文 #tech/bun", title: "Bun test 徹底解説" },
    });
    expect(contentText(update)).toContain("Bun test 徹底解説");

    const tags = await client.callTool({
      name: "kura_list_tags",
      arguments: { prefix: "tech" },
    });
    const tagsMd = contentText(tags);
    expect(tagsMd).toContain("tech/bun");
    expect(tagsMd).not.toContain("メモ");
  });

  test("kura_related がリンク 3 種を返す", async () => {
    const result = await client.callTool({
      name: "kura_related",
      arguments: { key: "トランザクション設計" },
    });
    const md = contentText(result);
    expect(md).toContain("バックリンク");
    expect(md).toContain("SQLite の WAL モード");
  });

  test("kura_status が統計を返す", async () => {
    const result = await client.callTool({ name: "kura_status", arguments: {} });
    const md = contentText(result);
    expect(md).toContain("ドキュメント: 2 件");
    expect(md).toContain("main: 2");
    expect(md).toContain("トークナイザー: trigram");
  });

  test("存在しない key はエラー扱い（isError）", async () => {
    const result = (await client.callTool({
      name: "kura_get",
      arguments: { key: "deadbeef" },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
