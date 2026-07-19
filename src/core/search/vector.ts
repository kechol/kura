import type { Database, Statement } from "bun:sqlite";
import type { KuraConfig } from "../config";
import type { LLMProvider } from "../llm/provider";
import type { SearchHit } from "./types";

export interface VectorOptions {
  bucket?: string;
  tag?: string;
  limit?: number;
}

/** Auto-backfill before search when the number of un-embedded chunks is at or below this (docs: search-pipeline.md) */
export const AUTO_BACKFILL_LIMIT = 100;

const EMBED_BATCH_SIZE = 16;

export function pendingChunkCount(db: Database): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM chunks WHERE embedded_at IS NULL").get() as {
    n: number;
  };
  return row.n;
}

function toBlob(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export interface BackfillOptions {
  /** true forces regeneration of all chunks (`kura embed --all`) */
  all?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface BackfillResult {
  embedded: number;
  total: number;
}

/**
 * Backfill un-embedded chunks. Resumable after interruption via embedded_at.
 * Updates chunks_vec / embedded_at in a transaction per batch.
 */
export async function backfillEmbeddings(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  opts: BackfillOptions = {},
): Promise<BackfillResult> {
  const model = config.llm.models.embedding;
  const dimensions = config.llm.models.embedding_dimensions;

  if (opts.all) {
    db.exec("DELETE FROM chunks_vec");
    db.exec("UPDATE chunks SET embedded_at = NULL");
  }
  const rows = db
    .prepare("SELECT id, text FROM chunks WHERE embedded_at IS NULL ORDER BY id")
    .all() as Array<{ id: number; text: string }>;

  let done = 0;
  for (let i = 0; i < rows.length; i += EMBED_BATCH_SIZE) {
    const batch = rows.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await provider.embed(
      batch.map((r) => r.text),
      model,
      dimensions,
    );
    db.transaction(() => {
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!;
        const vec = vectors[j]!;
        if (vec.length !== dimensions) {
          throw new Error(
            `embedding dimension (${vec.length}) does not match the configured value (${dimensions}). Review embedding_dimensions in config and run 'kura embed --all'`,
          );
        }
        db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?").run(chunk.id);
        db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)").run(
          chunk.id,
          toBlob(vec),
        );
        db.prepare("UPDATE chunks SET embedded_at = datetime('now') WHERE id = ?").run(chunk.id);
      }
    })();
    done += batch.length;
    opts.onProgress?.(done, rows.length);
  }
  return { embedded: done, total: rows.length };
}

/**
 * Pre-search embedding consistency check. Auto-backfills when the backlog is small;
 * otherwise returns a warning string and search continues with existing embeddings (docs: search-pipeline.md).
 */
export async function ensureEmbeddings(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
): Promise<string | null> {
  const pending = pendingChunkCount(db);
  if (pending === 0) return null;
  if (pending <= AUTO_BACKFILL_LIMIT) {
    await backfillEmbeddings(db, provider, config);
    return null;
  }
  return `${pending} chunk(s) are not embedded yet; search results may be incomplete (run 'kura embed')`;
}

/** Internal vector-search result including the full chunk text (for rerank) */
export interface VectorHitDetail {
  hit: SearchHit;
  chunkText: string;
}

/** Chunk text → display snippet: strip the context header (first line), collapse whitespace, truncate */
export function chunkSnippet(text: string, max = 160): string {
  const body = text
    .replace(/^# [^\n]*\n+/, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return body.length > max ? `${body.slice(0, max)}…` : body;
}

/**
 * KNN distance ⇄ similarity score. chunks_vec returns a raw L2 distance; the
 * search pipeline reports a bounded 0-1 similarity of 1 / (1 + distance)
 * (docs: search-pipeline.md). similarityToDistance inverts it to turn a
 * similarity floor back into a distance ceiling for KNN filtering.
 */
export function distanceToSimilarity(d: number): number {
  return 1 / (1 + d);
}
export function similarityToDistance(s: number): number {
  return 1 / s - 1;
}

/**
 * Prepared chunks_vec KNN statement (`embedding MATCH ? AND k = ?`, returning
 * chunk_id + distance). Shared by the audit and dedupe scans that run it per
 * chunk in a loop; any chunk→document join or filtering stays at the call site.
 */
export function prepareChunkKnn(db: Database): Statement {
  return db.prepare("SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?");
}

/** Query embedding -> chunks_vec KNN -> aggregate per document by best chunk (docs: search-pipeline.md) */
export async function vectorSearchDetailed(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  rawQuery: string,
  opts: VectorOptions = {},
): Promise<VectorHitDetail[]> {
  const query = rawQuery.trim();
  if (query === "") return [];
  const limit = opts.limit ?? 20;
  const [queryVec] = await provider.embed(
    [query],
    config.llm.models.embedding,
    config.llm.models.embedding_dimensions,
  );
  if (!queryVec) throw new Error("failed to generate the query embedding");

  const k = Math.max(limit * 4, 40);
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (opts.bucket) {
    where.push("b.name = ?");
    params.push(opts.bucket);
  }
  if (opts.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
        WHERE dt.document_id = d.id AND (t.path = ? OR t.path LIKE ? || '/%'))`,
    );
    params.push(opts.tag, opts.tag);
  }

  const rows = db
    .prepare(
      `WITH knn AS (
         SELECT chunk_id, distance FROM chunks_vec
         WHERE embedding MATCH ? AND k = ?
       )
       SELECT d.id, d.doc_key, d.path, d.title, b.name AS bucket,
              (SELECT group_concat(t.path, ' ') FROM document_tags dt
                JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id) AS tag_paths,
              c.text AS chunk_text, knn.distance
       FROM knn
       JOIN chunks c ON c.id = knn.chunk_id
       JOIN documents d ON d.id = c.document_id
       JOIN buckets b ON b.id = d.bucket_id
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY knn.distance`,
    )
    .all(toBlob(queryVec), k, ...params) as Array<{
    id: number;
    doc_key: string;
    path: string;
    title: string;
    bucket: string;
    tag_paths: string | null;
    chunk_text: string;
    distance: number;
  }>;

  // Aggregate per document, keeping the best (smallest-distance) chunk
  const byDoc = new Map<number, VectorHitDetail>();
  for (const row of rows) {
    if (byDoc.has(row.id)) continue;
    byDoc.set(row.id, {
      chunkText: row.chunk_text,
      hit: {
        docId: row.id,
        key: row.doc_key,
        path: row.path,
        title: row.title,
        bucket: row.bucket,
        tags: row.tag_paths ? row.tag_paths.split(" ") : [],
        score: distanceToSimilarity(row.distance),
        snippet: chunkSnippet(row.chunk_text),
        source: "vector",
      },
    });
    if (byDoc.size >= limit) break;
  }
  return [...byDoc.values()];
}

export async function vectorSearch(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  rawQuery: string,
  opts: VectorOptions = {},
): Promise<SearchHit[]> {
  return (await vectorSearchDetailed(db, provider, config, rawQuery, opts)).map((d) => d.hit);
}
