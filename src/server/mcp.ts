import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { KuraConfig } from "../core/config";
import type { FtsTokenizer } from "../core/db";
import { createDocument, resolveDoc, touchAccess, updateDocument } from "../core/documents";
import { backlinks, outlinks, twoHopLinks } from "../core/links";
import { KURA_VERSION } from "../core/paths";
import { hybridQuery } from "../core/search/hybrid";
import { keywordSearch } from "../core/search/keyword";
import type { SearchHit } from "../core/search/types";
import { collectStats } from "../core/stats";
import { listTags } from "../core/tags";

export interface McpDeps {
  db: Database;
  tokenizer: FtsTokenizer;
  config: KuraConfig;
}

function text(md: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: md }] };
}

function errorResult(e: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: `error: ${e instanceof Error ? e.message : e}` }],
    isError: true,
  };
}

function hitsToMarkdown(hits: SearchHit[], warnings: string[] = []): string {
  const lines: string[] = [];
  for (const w of warnings) lines.push(`> ⚠ ${w}`);
  if (hits.length === 0) {
    lines.push("該当するドキュメントはありませんでした。");
    return lines.join("\n");
  }
  for (const h of hits) {
    const tags = h.tags.length > 0 ? ` — tags: ${h.tags.join(", ")}` : "";
    lines.push(`- **${h.title}** (key: \`${h.key}\`, bucket: ${h.bucket}${tags})`);
    if (h.snippet) lines.push(`  ${h.snippet.replaceAll("\n", " ")}`);
  }
  lines.push("");
  lines.push("全文は `kura_get` に key を渡して取得してください。");
  return lines.join("\n");
}

function sliceLines(content: string, lines?: string): string {
  if (!lines) return content;
  const m = lines.match(/^(\d*):(\d*)$/);
  if (!m) throw new Error(`invalid lines range: ${lines} (expected e.g. 50:100)`);
  const all = content.split("\n");
  const start = m[1] ? Number.parseInt(m[1], 10) : 1;
  const end = m[2] ? Number.parseInt(m[2], 10) : all.length;
  return all.slice(Math.max(0, start - 1), end).join("\n");
}

/** kura MCP サーバー（SPEC §9）。8 ツールを公開し、結果は Markdown 文字列で返す */
export function createMcpServer(deps: McpDeps): McpServer {
  const { db, tokenizer, config } = deps;
  const server = new McpServer({ name: "kura", version: KURA_VERSION });

  const filterShape = {
    bucket: z.string().optional().describe("Bucket 名で絞り込み（省略時は全 Bucket）"),
    tag: z.string().optional().describe("階層タグで絞り込み（子孫タグを含む。例: tech/db）"),
    limit: z.number().int().min(1).max(50).optional().describe("最大件数"),
  };

  server.registerTool(
    "kura_query",
    {
      description:
        "ナレッジベースのハイブリッド検索（キーワード + セマンティック + リランク）。" +
        "ユーザーの質問に関連する知識を探すときは、まずこのツールで検索し、" +
        "ヒットした key を kura_get に渡して全文を取得すること。" +
        "速度優先・完全一致狙いのときは kura_search を使う。",
      inputSchema: {
        query: z.string().describe("自然文または キーワードの検索クエリ（日本語可）"),
        ...filterShape,
      },
    },
    async ({ query, bucket, tag, limit }) => {
      try {
        const outcome = await hybridQuery(db, tokenizer, config, query, {
          bucket,
          tag,
          limit: limit ?? config.search.default_limit,
        });
        return text(hitsToMarkdown(outcome.hits, outcome.warnings));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_search",
    {
      description:
        "高速キーワード検索（FTS5 BM25、LLM 不使用）。固有名詞や正確な語句で探すときに使う。" +
        "意味的な検索が必要なら kura_query を使う。",
      inputSchema: {
        query: z.string().describe("検索キーワード（空白区切りで OR 検索）"),
        ...filterShape,
      },
    },
    ({ query, bucket, tag, limit }) => {
      try {
        const hits = keywordSearch(db, tokenizer, query, { bucket, tag, limit: limit ?? 10 });
        return text(hitsToMarkdown(hits));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_get",
    {
      description:
        "ドキュメントの全文を取得する。key は kura_query / kura_search の結果に含まれる 8 文字 ID。" +
        "長大なドキュメントは lines で範囲指定できる（例: '1:100'）。",
      inputSchema: {
        key: z.string().describe("doc_key（8 文字）またはドキュメントタイトル"),
        lines: z.string().optional().describe("行範囲 'START:END'（1 始まり、省略可）"),
      },
    },
    ({ key, lines }) => {
      try {
        const doc = resolveDoc(db, key);
        touchAccess(db, doc.id);
        const meta = [
          `key: \`${doc.key}\` / bucket: ${doc.bucket}`,
          doc.tags.length > 0 ? `tags: ${doc.tags.join(", ")}` : null,
          doc.sourceUrl ? `source: ${doc.sourceUrl}` : null,
          `updated: ${doc.updatedAt}`,
        ]
          .filter(Boolean)
          .join(" / ");
        return text(`# ${doc.title}\n\n> ${meta}\n\n${sliceLines(doc.content, lines)}`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_add",
    {
      description:
        "新しいドキュメントをナレッジベースに追加する。本文は Markdown。" +
        "[[タイトル]] 形式で他ドキュメントへのリンク、#tag/path 形式でタグを本文中に書ける。",
      inputSchema: {
        title: z.string().describe("ドキュメントタイトル（Bucket 内で一意）"),
        content: z.string().describe("Markdown 本文"),
        bucket: z.string().optional().describe("Bucket 名（省略時は既定 Bucket）"),
        tags: z.array(z.string()).optional().describe("タグ（階層は / 区切り）"),
      },
    },
    ({ title, content, bucket, tags }) => {
      try {
        const doc = createDocument(db, {
          title,
          content,
          bucket: bucket ?? config.general.default_bucket,
          tags,
        });
        return text(`追加しました: **${doc.title}** (key: \`${doc.key}\`, bucket: ${doc.bucket})`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_update",
    {
      description:
        "既存ドキュメントを更新する。content を渡すと本文全体を置き換える。" +
        "title を渡すとリネームし、他ドキュメントからの [[リンク]] も自動で張り替わる。" +
        "tags は追加のみ（削除しない）。",
      inputSchema: {
        key: z.string().describe("doc_key（8 文字）またはタイトル"),
        content: z.string().optional().describe("新しい Markdown 本文（全置換）"),
        title: z.string().optional().describe("新しいタイトル（リネーム）"),
        tags: z.array(z.string()).optional().describe("追加するタグ"),
      },
    },
    ({ key, content, title, tags }) => {
      try {
        const doc = resolveDoc(db, key);
        const { record, relinked } = updateDocument(db, doc.id, { content, title, tags });
        const note = relinked > 0 ? `（${relinked} 件の被リンクを張り替え）` : "";
        return text(`更新しました: **${record.title}** (key: \`${record.key}\`)${note}`);
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_list_tags",
    {
      description:
        "タグ一覧と件数を取得する。新しいドキュメントにタグを付ける前に、" +
        "既存のタグ体系を確認して再利用するために使う。",
      inputSchema: {
        prefix: z.string().optional().describe("タグパスの前方一致フィルタ（例: tech）"),
      },
    },
    ({ prefix }) => {
      try {
        let tags = listTags(db);
        if (prefix) {
          const p = prefix.toLowerCase();
          tags = tags.filter((t) => t.path === p || t.path.startsWith(`${p}/`));
        }
        if (tags.length === 0) return text("タグはありません。");
        return text(tags.map((t) => `- ${t.path} (${t.count})`).join("\n"));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_related",
    {
      description:
        "ドキュメントの関連情報（アウトリンク・バックリンク・2ホップリンク）を取得する。" +
        "あるトピックの周辺知識を辿るときに使う。",
      inputSchema: {
        key: z.string().describe("doc_key（8 文字）またはタイトル"),
      },
    },
    ({ key }) => {
      try {
        const doc = resolveDoc(db, key);
        const lines: string[] = [`# ${doc.title} の関連ドキュメント`];
        const out = outlinks(db, doc.id);
        lines.push("", "## アウトリンク");
        lines.push(
          out.length === 0
            ? "（なし）"
            : out
                .map((l) =>
                  l.target
                    ? `- [[${l.targetTitle}]] → \`${l.target.key}\``
                    : `- [[${l.targetTitle}]]（未作成）`,
                )
                .join("\n"),
        );
        const back = backlinks(db, doc.id);
        lines.push("", "## バックリンク");
        lines.push(
          back.length === 0
            ? "（なし）"
            : back.map((d) => `- ${d.title} (\`${d.key}\`)`).join("\n"),
        );
        const hops = twoHopLinks(db, doc.id);
        lines.push("", "## 2ホップリンク（共通リンク先を持つドキュメント）");
        lines.push(
          hops.length === 0
            ? "（なし）"
            : hops
                .map(
                  (g) =>
                    `- via [[${g.via.title}]]: ${g.docs.map((d) => `${d.title} (\`${d.key}\`)`).join(", ")}`,
                )
                .join("\n"),
        );
        return text(lines.join("\n"));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_status",
    {
      description: "ナレッジベースの統計情報（件数・タグ数・embedding カバレッジなど）を取得する。",
      inputSchema: {},
    },
    () => {
      try {
        const s = collectStats(db, config);
        const buckets = s.buckets.map((b) => `  - ${b.name}: ${b.documents}`).join("\n");
        return text(
          [
            `- ドキュメント: ${s.documents} 件`,
            `- Bucket:\n${buckets}`,
            `- タグ: ${s.tags} 件`,
            `- チャンク: ${s.chunks} 件（embedding 済み ${s.embeddedChunks}、カバレッジ ${(s.embeddingCoverage * 100).toFixed(1)}%）`,
            `- 陳腐化候補: ${s.staleDocuments} 件 / 未解決リンク: ${s.unresolvedLinks} 件`,
            `- DB サイズ: ${(s.dbSizeBytes / 1024 / 1024).toFixed(2)} MB / トークナイザー: ${s.tokenizer}`,
          ].join("\n"),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}
