import type { Database } from "bun:sqlite";
import { listBuckets } from "../core/buckets";
import type { KuraConfig } from "../core/config";
import type { FtsTokenizer } from "../core/db";
import {
  type DocumentRecord,
  deleteDocument,
  getDocumentByKey,
  listDocuments,
  touchAccess,
  updateDocument,
} from "../core/documents";
import { ConflictError, NotFoundError, UsageError } from "../core/errors";
import { backlinks, outlinks, twoHopLinks } from "../core/links";
import { requireProvider, resolveProvider } from "../core/llm/provider";
import { hybridQuery } from "../core/search/hybrid";
import { keywordSearch } from "../core/search/keyword";
import type { SearchHit } from "../core/search/types";
import { ensureEmbeddings, vectorSearch } from "../core/search/vector";
import { collectStats } from "../core/stats";
import { addTagsToDoc, buildTagTree, listTags, removeTagsFromDoc } from "../core/tags";

export interface ApiDeps {
  db: Database;
  tokenizer: FtsTokenizer;
  config: KuraConfig;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(e: unknown): Response {
  if (e instanceof NotFoundError) return json({ error: e.message }, 404);
  if (e instanceof UsageError) return json({ error: e.message }, 400);
  if (e instanceof ConflictError) return json({ error: e.message }, 409);
  return json({ error: e instanceof Error ? e.message : String(e) }, 500);
}

function docJson(doc: DocumentRecord, content = false): Record<string, unknown> {
  return {
    key: doc.key,
    title: doc.title,
    bucket: doc.bucket,
    tags: doc.tags,
    content_type: doc.contentType,
    source_url: doc.sourceUrl,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
    last_accessed_at: doc.lastAccessedAt,
    access_count: doc.accessCount,
    ...(content ? { content: doc.content } : {}),
  };
}

function hitJson(h: SearchHit): Record<string, unknown> {
  return {
    key: h.key,
    title: h.title,
    bucket: h.bucket,
    tags: h.tags,
    score: h.score,
    snippet: h.snippet,
    source: h.source,
  };
}

function requireDoc(db: Database, key: string): DocumentRecord {
  const doc = getDocumentByKey(db, key);
  if (!doc) throw new NotFoundError(`document not found: ${key}`);
  return doc;
}

const STALE_CUTOFF = (days: number): string => `-${days} days`;

/** All REST API routes (SPEC §8.2). Passed to Bun.serve's routes */
export function createApiRoutes(
  deps: ApiDeps,
): Record<
  string,
  (req: Request & { params: Record<string, string> }) => Promise<Response> | Response
> {
  const { db, tokenizer, config } = deps;

  const wrap =
    (
      handler: (req: Request & { params: Record<string, string> }) => Promise<Response> | Response,
    ) =>
    async (req: Request & { params: Record<string, string> }): Promise<Response> => {
      try {
        return await handler(req);
      } catch (e) {
        return errorResponse(e);
      }
    };

  const routes: Record<string, unknown> = {
    "/api/stats": wrap(() => json(collectStats(db, config))),

    "/api/buckets": wrap(() => json(listBuckets(db))),

    "/api/docs": wrap((req) => {
      const url = new URL(req.url);
      const bucket = url.searchParams.get("bucket") ?? undefined;
      const tag = url.searchParams.get("tag") ?? undefined;
      const sortParam = url.searchParams.get("sort") ?? "updated";
      if (!["updated", "created", "accessed", "title"].includes(sortParam)) {
        throw new UsageError(`invalid sort: ${sortParam}`);
      }
      const stale = url.searchParams.get("stale") === "1";
      const per = Math.min(Number.parseInt(url.searchParams.get("per") ?? "50", 10) || 50, 200);
      const page = Math.max(Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1, 1);

      const filter = {
        bucket,
        tag,
        sort: sortParam as "updated" | "created" | "accessed" | "title",
        stale,
        staleDays: config.general.stale_days,
      };
      const docs = listDocuments(db, { ...filter, limit: per, offset: (page - 1) * per });
      const total = listDocumentsCount(db, filter);
      return json({ docs: docs.map((d) => docJson(d)), total, page, per });
    }),

    "/api/docs/:key": {
      GET: wrap((req) => {
        const doc = requireDoc(db, req.params.key ?? "");
        touchAccess(db, doc.id);
        return json(docJson({ ...doc, accessCount: doc.accessCount + 1 }, true));
      }),
      PUT: wrap(async (req) => {
        const doc = requireDoc(db, req.params.key ?? "");
        const body = (await req.json()) as {
          title?: string;
          content?: string;
          tags?: string[];
        };
        // Tags are diff-synced with the editor state as the source of truth
        if (Array.isArray(body.tags)) {
          const current = new Set(doc.tags);
          const next = new Set(body.tags);
          const toRemove = [...current].filter((t) => !next.has(t));
          if (toRemove.length > 0) removeTagsFromDoc(db, doc.id, toRemove);
          const toAdd = [...next].filter((t) => !current.has(t));
          if (toAdd.length > 0) addTagsToDoc(db, doc.id, toAdd);
        }
        const { record } = updateDocument(db, doc.id, {
          title: body.title,
          content: body.content,
        });
        return json(docJson(record, true));
      }),
      DELETE: wrap((req) => {
        const doc = requireDoc(db, req.params.key ?? "");
        deleteDocument(db, doc.id);
        return json({ deleted: doc.key });
      }),
    },

    "/api/docs/:key/related": wrap((req) => {
      const doc = requireDoc(db, req.params.key ?? "");
      return json({
        outlinks: outlinks(db, doc.id).map((l) => ({
          target_title: l.targetTitle,
          target: l.target,
        })),
        backlinks: backlinks(db, doc.id),
        twoHop: twoHopLinks(db, doc.id),
      });
    }),

    "/api/search": wrap(async (req) => {
      const url = new URL(req.url);
      const q = url.searchParams.get("q")?.trim() ?? "";
      if (q === "") throw new UsageError("query parameter 'q' is required");
      const mode = url.searchParams.get("mode") ?? "keyword";
      const bucket = url.searchParams.get("bucket") ?? undefined;
      const tag = url.searchParams.get("tag") ?? undefined;
      const limit = Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20;

      if (mode === "keyword") {
        const hits = keywordSearch(db, tokenizer, q, { bucket, tag, limit });
        return json({ hits: hits.map(hitJson), warnings: [] });
      }
      if (mode === "vector") {
        const provider = await requireProvider(config);
        const warn = await ensureEmbeddings(db, provider, config);
        const hits = await vectorSearch(db, provider, config, q, { bucket, tag, limit });
        return json({ hits: hits.map(hitJson), warnings: warn ? [warn] : [] });
      }
      if (mode === "hybrid") {
        const outcome = await hybridQuery(db, tokenizer, config, q, { bucket, tag, limit });
        return json({ hits: outcome.hits.map(hitJson), warnings: outcome.warnings });
      }
      throw new UsageError(`invalid mode: ${mode}`);
    }),

    "/api/tags": wrap((req) => {
      const url = new URL(req.url);
      const entries = listTags(db);
      if (url.searchParams.get("tree") === "1") {
        return json(buildTagTree(entries));
      }
      return json(entries);
    }),

    "/api/graph": wrap((req) => {
      const url = new URL(req.url);
      return json(
        buildGraph(db, config, {
          bucket: url.searchParams.get("bucket") ?? undefined,
          tag: url.searchParams.get("tag") ?? undefined,
        }),
      );
    }),

    "/api/llm": wrap(async () => {
      const provider = await resolveProvider(config);
      return json({ provider: provider?.name ?? null });
    }),
  };

  return routes as ReturnType<typeof createApiRoutes>;
}

function listDocumentsCount(
  db: Database,
  filter: { bucket?: string; tag?: string; stale?: boolean; staleDays: number },
): number {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.bucket) {
    where.push("b.name = ?");
    params.push(filter.bucket);
  }
  if (filter.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
        WHERE dt.document_id = d.id AND (t.path = ? OR t.path LIKE ? || '/%'))`,
    );
    params.push(filter.tag, filter.tag);
  }
  if (filter.stale) {
    where.push("d.updated_at < datetime('now', ?)");
    params.push(STALE_CUTOFF(filter.staleDays));
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM documents d JOIN buckets b ON b.id = d.bucket_id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`,
    )
    .get(...params) as { n: number };
  return row.n;
}

interface GraphNode {
  key: string;
  title: string;
  tags: string[];
  degree: number;
  stale: boolean;
}

interface GraphEdge {
  source: string;
  target: string;
}

/** Knowledge graph: nodes = documents, edges = resolved links (SPEC §8.2) */
function buildGraph(
  db: Database,
  config: KuraConfig,
  filter: { bucket?: string; tag?: string },
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const docs = listDocuments(db, { bucket: filter.bucket, tag: filter.tag });
  const byId = new Map(docs.map((d) => [d.id, d]));
  const cutoff = new Date(Date.now() - config.general.stale_days * 86_400_000)
    .toISOString()
    .slice(0, 19)
    .replace("T", " ");

  const edges: GraphEdge[] = [];
  const degree = new Map<number, number>();
  const rows = db
    .prepare("SELECT source_id, target_id FROM links WHERE target_id IS NOT NULL")
    .all() as Array<{ source_id: number; target_id: number }>;
  for (const r of rows) {
    const source = byId.get(r.source_id);
    const target = byId.get(r.target_id);
    if (!source || !target) continue;
    edges.push({ source: source.key, target: target.key });
    degree.set(r.source_id, (degree.get(r.source_id) ?? 0) + 1);
    degree.set(r.target_id, (degree.get(r.target_id) ?? 0) + 1);
  }

  const nodes = docs.map((d) => ({
    key: d.key,
    title: d.title,
    tags: d.tags,
    degree: degree.get(d.id) ?? 0,
    stale: d.updatedAt < cutoff,
  }));
  return { nodes, edges };
}
