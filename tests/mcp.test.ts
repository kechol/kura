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
  // Search tests run deterministically in degraded mode (no LLM provider)
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
  test("exposes 10 tools with guidance in descriptions", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "kura_add",
      "kura_ask",
      "kura_changes",
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

  test("kura_search → kura_get flow (including access_count update)", async () => {
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

  test("kura_ask degrades to search results when no provider is available", async () => {
    const result = await client.callTool({
      name: "kura_ask",
      arguments: { question: "トランザクションの分離レベル" },
    });
    const md = contentText(result);
    expect(md).toContain("⚠");
    expect(md).toContain("トランザクション設計");
    expect(md).not.toContain("## Sources");
  });

  test("kura_query responds even in degraded mode (with warnings)", async () => {
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

  test("kura_related returns all three link kinds", async () => {
    const result = await client.callTool({
      name: "kura_related",
      arguments: { key: "トランザクション設計" },
    });
    const md = contentText(result);
    expect(md).toContain("Backlinks");
    expect(md).toContain("SQLite の WAL モード");
  });

  test("kura_changes lists documents changed since a point in time", async () => {
    const all = await client.callTool({
      name: "kura_changes",
      arguments: { since: "1h" },
    });
    const md = contentText(all);
    expect(md).toContain("**created**");
    expect(md).toContain("SQLite の WAL モード");

    const none = await client.callTool({
      name: "kura_changes",
      arguments: { since: "2099-01-01" },
    });
    expect(contentText(none)).toContain("No changes");

    const bad = (await client.callTool({
      name: "kura_changes",
      arguments: { since: "そのうち" },
    })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
  });

  test("kura_status returns statistics", async () => {
    const result = await client.callTool({ name: "kura_status", arguments: {} });
    const md = contentText(result);
    expect(md).toContain("Documents: 2");
    expect(md).toContain("main: 2");
    expect(md).toContain("tokenizer: trigram");
  });

  test("unknown key is reported as an error (isError)", async () => {
    const result = (await client.callTool({
      name: "kura_get",
      arguments: { key: "deadbeef" },
    })) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });

  test("kura_add files a document under a path; kura_get resolves the full path", async () => {
    const added = await client.callTool({
      name: "kura_add",
      arguments: { title: "vec 拡張の調査", content: "本文", path: "db/sqlite" },
    });
    expect(contentText(added)).toContain("db/sqlite/vec 拡張の調査");

    const got = await client.callTool({
      name: "kura_get",
      arguments: { key: "db/sqlite/vec 拡張の調査" },
    });
    const md = contentText(got);
    expect(md).toContain("# vec 拡張の調査");
    expect(md).toContain("path: db/sqlite");
  });

  test("kura_update moves a document with path", async () => {
    const result = await client.callTool({
      name: "kura_update",
      arguments: { key: "トランザクション設計", path: "db" },
    });
    expect(contentText(result)).toContain("db/トランザクション設計");
  });

  test("kura_add accepts aliases; kura_get shows and resolves them", async () => {
    await client.callTool({
      name: "kura_add",
      arguments: { title: "データベース設計", content: "正規化の方針。", aliases: ["DB設計"] },
    });
    const got = await client.callTool({ name: "kura_get", arguments: { key: "DB設計" } });
    const md = contentText(got);
    expect(md).toContain("# データベース設計");
    expect(md).toContain("aliases: DB設計");
  });
});
