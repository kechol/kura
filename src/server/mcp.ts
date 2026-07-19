import type { Database } from "bun:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { changesSince, parseSince } from "../core/changes";
import type { KuraConfig } from "../core/config";
import type { FtsTokenizer } from "../core/db";
import { createDocument, resolveDoc, touchAccess, updateDocument } from "../core/documents";
import { backlinks, outlinks, twoHopLinks } from "../core/links";
import { KURA_VERSION } from "../core/paths";
import { askQuestion } from "../core/search/ask";
import { hybridQuery } from "../core/search/hybrid";
import { keywordSearch } from "../core/search/keyword";
import type { SearchHit } from "../core/search/types";
import { collectStats } from "../core/stats";
import { listTags } from "../core/tags";
import { joinDocPath } from "../core/wiki";

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
    lines.push("No matching documents found.");
    return lines.join("\n");
  }
  for (const h of hits) {
    const tags = h.tags.length > 0 ? ` — tags: ${h.tags.join(", ")}` : "";
    lines.push(
      `- **${joinDocPath(h.path, h.title)}** (key: \`${h.key}\`, bucket: ${h.bucket}${tags})`,
    );
    if (h.snippet) lines.push(`  ${h.snippet.replaceAll("\n", " ")}`);
  }
  lines.push("");
  lines.push("Pass a key to `kura_get` to retrieve the full text.");
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

/** kura MCP server (docs: mcp-server.md). Exposes 10 tools; results are returned as Markdown strings */
export function createMcpServer(deps: McpDeps): McpServer {
  const { db, tokenizer, config } = deps;
  const server = new McpServer({ name: "kura", version: KURA_VERSION });

  const filterShape = {
    bucket: z.string().optional().describe("Filter by bucket name (all buckets if omitted)"),
    tag: z
      .string()
      .optional()
      .describe("Filter by hierarchical tag (includes descendant tags, e.g. tech/db)"),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum number of results"),
  };

  server.registerTool(
    "kura_query",
    {
      description:
        "Hybrid search over the knowledge base (keyword + semantic + rerank). " +
        "When looking for knowledge relevant to a user question, search with this tool first, " +
        "then pass a hit's key to kura_get to retrieve the full text. " +
        "Use kura_search when speed or exact matches matter.",
      inputSchema: {
        query: z
          .string()
          .describe("Search query in natural language or keywords (Japanese supported)"),
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
    "kura_ask",
    {
      description:
        "Answer a question from the knowledge base with cited sources. Runs a hybrid " +
        "search, then generates an answer strictly from the top hits, citing them as " +
        "[1], [2], ... Falls back to plain search results when no LLM provider is " +
        "available. Use kura_query when you want raw hits instead of an answer.",
      inputSchema: {
        question: z.string().describe("Question in natural language (Japanese supported)"),
        ...filterShape,
      },
    },
    async ({ question, bucket, tag, limit }) => {
      try {
        const outcome = await askQuestion(db, tokenizer, config, question, {
          bucket,
          tag,
          limit: limit ?? config.search.default_limit,
        });
        const lines: string[] = [];
        for (const w of outcome.warnings) lines.push(`> ⚠ ${w}`);
        if (outcome.answer === null) {
          lines.push(hitsToMarkdown(outcome.hits));
          return text(lines.join("\n"));
        }
        lines.push(outcome.answer, "", "## Sources");
        outcome.sources.forEach((s, i) => {
          lines.push(`- [${i + 1}] **${joinDocPath(s.path, s.title)}** (key: \`${s.key}\`)`);
        });
        lines.push("", "Pass a key to `kura_get` to verify a source.");
        return text(lines.join("\n"));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_search",
    {
      description:
        "Fast keyword search (FTS5 BM25, no LLM). Use for proper nouns or exact phrases. " +
        "Use kura_query when semantic search is needed.",
      inputSchema: {
        query: z.string().describe("Search keywords (space-separated terms, OR search)"),
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
        "Retrieve the full text of a document. key is the 8-character ID included in " +
        "kura_query / kura_search results. For long documents, restrict the output with " +
        "lines (e.g. '1:100').",
      inputSchema: {
        key: z
          .string()
          .describe("doc_key (8 characters), full path (e.g. clips/Title), or document title"),
        lines: z.string().optional().describe("Line range 'START:END' (1-based, optional)"),
      },
    },
    ({ key, lines }) => {
      try {
        const doc = resolveDoc(db, key);
        touchAccess(db, doc.id);
        const meta = [
          `key: \`${doc.key}\` / bucket: ${doc.bucket}`,
          doc.path !== "" ? `path: ${doc.path}` : null,
          doc.tags.length > 0 ? `tags: ${doc.tags.join(", ")}` : null,
          doc.aliases.length > 0 ? `aliases: ${doc.aliases.join(", ")}` : null,
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
        "Add a new document to the knowledge base. The body is Markdown. " +
        "Link to other documents with [[Title]] and write tags inline as #tag/path.",
      inputSchema: {
        title: z.string().describe("Document title (path + title is unique within a bucket)"),
        content: z.string().describe("Markdown body"),
        bucket: z.string().optional().describe("Bucket name (default bucket if omitted)"),
        path: z
          .string()
          .optional()
          .describe("Folder-like document path (e.g. 'db/sqlite'); omit for the bucket root"),
        tags: z.array(z.string()).optional().describe("Tags (hierarchy separated by /)"),
        aliases: z
          .array(z.string())
          .optional()
          .describe("Alternate titles for [[links]] and search (e.g. orthographic variants)"),
      },
    },
    ({ title, content, bucket, path, tags, aliases }) => {
      try {
        const doc = createDocument(db, {
          title,
          content,
          bucket: bucket ?? config.general.default_bucket,
          path,
          tags,
          aliases,
        });
        return text(
          `Added: **${joinDocPath(doc.path, doc.title)}** (key: \`${doc.key}\`, bucket: ${doc.bucket})`,
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_update",
    {
      description:
        "Update an existing document. Passing content replaces the entire body. " +
        "Passing title renames the document, passing path moves it; both " +
        "automatically rewrite [[links]] from other documents. tags and aliases " +
        "are add-only (never removed).",
      inputSchema: {
        key: z.string().describe("doc_key (8 characters), full path, or title"),
        content: z.string().optional().describe("New Markdown body (full replacement)"),
        title: z.string().optional().describe("New title (rename)"),
        path: z.string().optional().describe("New document path ('' moves to the bucket root)"),
        tags: z.array(z.string()).optional().describe("Tags to add"),
        aliases: z.array(z.string()).optional().describe("Aliases (alternate titles) to add"),
      },
    },
    ({ key, content, title, path, tags, aliases }) => {
      try {
        const doc = resolveDoc(db, key);
        const { record, relinked } = updateDocument(db, doc.id, {
          content,
          title,
          path,
          tags,
          aliases,
        });
        const note = relinked > 0 ? ` (relinked ${relinked} backlinks)` : "";
        return text(
          `Updated: **${joinDocPath(record.path, record.title)}** (key: \`${record.key}\`)${note}`,
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_list_tags",
    {
      description:
        "List tags with document counts. Use before tagging a new document to check " +
        "the existing tag hierarchy and reuse it.",
      inputSchema: {
        prefix: z.string().optional().describe("Tag path prefix filter (e.g. tech)"),
      },
    },
    ({ prefix }) => {
      try {
        let tags = listTags(db);
        if (prefix) {
          const p = prefix.toLowerCase();
          tags = tags.filter((t) => t.path === p || t.path.startsWith(`${p}/`));
        }
        if (tags.length === 0) return text("No tags found.");
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
        "Get related information for a document (outlinks, backlinks, two-hop links). " +
        "Use to explore knowledge around a topic.",
      inputSchema: {
        key: z.string().describe("doc_key (8 characters), full path, or title"),
      },
    },
    ({ key }) => {
      try {
        const doc = resolveDoc(db, key);
        const lines: string[] = [`# Related documents for ${doc.title}`];
        const out = outlinks(db, doc.id);
        lines.push("", "## Outlinks");
        lines.push(
          out.length === 0
            ? "(none)"
            : out
                .map((l) =>
                  l.target
                    ? `- [[${l.targetTitle}]] → \`${l.target.key}\``
                    : `- [[${l.targetTitle}]] (not created yet)`,
                )
                .join("\n"),
        );
        const back = backlinks(db, doc.id);
        lines.push("", "## Backlinks");
        lines.push(
          back.length === 0 ? "(none)" : back.map((d) => `- ${d.title} (\`${d.key}\`)`).join("\n"),
        );
        const hops = twoHopLinks(db, doc.id);
        lines.push("", "## Two-hop links (documents sharing a link target)");
        lines.push(
          hops.length === 0
            ? "(none)"
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
    "kura_changes",
    {
      description:
        "List documents created or updated since a point in time. Call at the start " +
        "of a session to catch up on what changed in the knowledge base since you " +
        "last looked. Renames and moves are detected against the revision history; " +
        "deletions are not tracked.",
      inputSchema: {
        since: z
          .string()
          .describe("Relative time (30m / 24h / 7d / 2w) or a date/datetime (ISO 8601)"),
        bucket: z.string().optional().describe("Filter by bucket name (all buckets if omitted)"),
        limit: z.number().int().min(1).max(200).optional().describe("Maximum entries (default 50)"),
      },
    },
    ({ since, bucket, limit }) => {
      try {
        const parsed = parseSince(since);
        if (parsed === null) {
          throw new Error(`invalid since: ${since} (expected e.g. 7d or 2026-07-01)`);
        }
        const changes = changesSince(db, parsed, { bucket, limit });
        if (changes.length === 0) return text(`No changes since ${parsed}.`);
        const lines = changes.map((c) => {
          const details: string[] = [];
          if (c.kind === "updated" && c.contentChanged) details.push("content");
          if (c.renamed) details.push(`renamed from ${c.previousTitle}`);
          if (c.moved)
            details.push(`moved from ${c.previousPath === "" ? "(root)" : c.previousPath}`);
          const suffix = details.length > 0 ? ` — ${details.join(", ")}` : "";
          return `- **${c.kind}** ${joinDocPath(c.path, c.title)} (key: \`${c.key}\`, bucket: ${c.bucket}) at ${c.updatedAt}${suffix}`;
        });
        lines.push("", "Pass a key to `kura_get` to read a document.");
        return text(lines.join("\n"));
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  server.registerTool(
    "kura_status",
    {
      description:
        "Get knowledge base statistics (document count, tag count, embedding coverage, etc.).",
      inputSchema: {},
    },
    () => {
      try {
        const s = collectStats(db, config);
        const buckets = s.buckets.map((b) => `  - ${b.name}: ${b.documents}`).join("\n");
        return text(
          [
            `- Documents: ${s.documents}`,
            `- Buckets:\n${buckets}`,
            `- Tags: ${s.tags}`,
            `- Chunks: ${s.chunks} (embedded ${s.embeddedChunks}, coverage ${(s.embeddingCoverage * 100).toFixed(1)}%)`,
            `- Stale candidates: ${s.staleDocuments} / unresolved links: ${s.unresolvedLinks}`,
            `- DB size: ${(s.dbSizeBytes / 1024 / 1024).toFixed(2)} MB / tokenizer: ${s.tokenizer}`,
          ].join("\n"),
        );
      } catch (e) {
        return errorResult(e);
      }
    },
  );

  return server;
}
