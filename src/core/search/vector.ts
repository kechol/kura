import type { Database, Statement } from "bun:sqlite";
import type { KuraConfig } from "../config";
import { setMeta } from "../db";
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

interface EmbeddingIdentity {
  model: string;
  dimensions: number;
}

function embeddingIdentity(config: KuraConfig): EmbeddingIdentity {
  const model = config.llm.models.embedding;
  const dimensions = config.llm.models.embedding_dimensions;
  if (!Number.isSafeInteger(dimensions) || dimensions <= 0) {
    throw new Error(`embedding_dimensions must be a positive integer, got: ${dimensions}`);
  }
  return { model, dimensions };
}

function assertStoredEmbeddingIdentity(db: Database, identity: EmbeddingIdentity): void {
  const stored = db
    .prepare(
      `SELECT
         MAX(CASE WHEN key = 'embedding_model' THEN value END) AS model,
         MAX(CASE WHEN key = 'embedding_dimensions' THEN value END) AS dimensions
       FROM meta WHERE key IN ('embedding_model', 'embedding_dimensions')`,
    )
    .get() as { model: string | null; dimensions: string | null };
  const storedModel = stored.model;
  const storedDimensions = stored.dimensions;
  if (storedModel === identity.model && storedDimensions === String(identity.dimensions)) return;
  throw new Error(
    `embedding identity mismatch (DB: ${storedModel ?? "unknown"}/${storedDimensions ?? "unknown"}, config: ${identity.model}/${identity.dimensions}). Run 'kura doctor --fix' and then 'kura embed' to rebuild the vector index`,
  );
}

/** Reject use of stored vectors when the configured model identity has drifted. */
export function assertEmbeddingIdentity(db: Database, config: KuraConfig): void {
  assertStoredEmbeddingIdentity(db, embeddingIdentity(config));
}

/** Atomically invalidate all vectors and recreate the index for the configured identity. */
export function resetEmbeddingIndex(db: Database, config: KuraConfig): void {
  const identity = embeddingIdentity(config);
  db.transaction(() => {
    db.exec("DROP TABLE chunks_vec");
    db.exec(
      `CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${identity.dimensions}])`,
    );
    db.exec("UPDATE chunks SET embedded_at = NULL");
    setMeta(db, "embedding_model", identity.model);
    setMeta(db, "embedding_dimensions", String(identity.dimensions));
  })();
}

function resetPendingEmbeddings(db: Database): void {
  db.transaction(() => {
    db.exec("DELETE FROM chunks_vec");
    db.exec("UPDATE chunks SET embedded_at = NULL");
  })();
}

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
  const identity = embeddingIdentity(config);
  assertStoredEmbeddingIdentity(db, identity);

  if (opts.all) {
    resetPendingEmbeddings(db);
  }
  const snapshot = db
    .prepare(
      "SELECT COUNT(*) AS total, COALESCE(MAX(id), 0) AS max_id FROM chunks WHERE embedded_at IS NULL",
    )
    .get() as { total: number; max_id: number };

  let done = 0;
  let processed = 0;
  let cursor = 0;
  for (;;) {
    const batch = db
      .prepare(
        `SELECT id, text FROM chunks
         WHERE embedded_at IS NULL AND id > ? AND id <= ?
         ORDER BY id LIMIT ${EMBED_BATCH_SIZE}`,
      )
      .all(cursor, snapshot.max_id) as Array<{ id: number; text: string }>;
    if (batch.length === 0) break;
    cursor = batch[batch.length - 1]!.id;
    const vectors = await provider.embed(
      batch.map((r) => r.text),
      identity.model,
      identity.dimensions,
    );
    if (vectors.length !== batch.length) {
      throw new Error(
        `embedding provider returned ${vectors.length} vectors for ${batch.length} chunks`,
      );
    }
    let committed = 0;
    db.transaction(() => {
      assertStoredEmbeddingIdentity(db, identity);
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]!;
        const vec = vectors[j]!;
        if (vec.length !== identity.dimensions) {
          throw new Error(
            `embedding dimension (${vec.length}) does not match the configured value (${identity.dimensions}). Review the embedding model and embedding_dimensions in config`,
          );
        }
        const current = db
          .prepare("SELECT text FROM chunks WHERE id = ? AND embedded_at IS NULL")
          .get(chunk.id) as { text: string } | null;
        if (!current || current.text !== chunk.text) continue;
        db.prepare("DELETE FROM chunks_vec WHERE chunk_id = ?").run(chunk.id);
        db.prepare("INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)").run(
          chunk.id,
          toBlob(vec),
        );
        db.prepare("UPDATE chunks SET embedded_at = datetime('now') WHERE id = ?").run(chunk.id);
        committed++;
      }
    })();
    done += committed;
    processed += batch.length;
    opts.onProgress?.(processed, snapshot.total);
  }
  return { embedded: done, total: snapshot.total };
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
  assertEmbeddingIdentity(db, config);
  const pending = pendingChunkCount(db);
  if (pending === 0) return null;
  if (pending <= AUTO_BACKFILL_LIMIT) {
    await backfillEmbeddings(db, provider, config);
    const remaining = pendingChunkCount(db);
    return remaining === 0
      ? null
      : `${remaining} chunk(s) are not embedded yet; search results may be incomplete (run 'kura embed')`;
  }
  return `${pending} chunk(s) are not embedded yet; search results may be incomplete (run 'kura embed')`;
}

/** Internal vector-search result including the full chunk text (for rerank) */
export interface VectorHitDetail {
  hit: SearchHit;
  chunkText: string;
}

interface VectorRow {
  id: number;
  doc_key: string;
  path: string;
  title: string;
  bucket: string;
  tag_paths: string | null;
  chunk_text: string;
  distance: number;
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
  const identity = embeddingIdentity(config);
  assertStoredEmbeddingIdentity(db, identity);
  const limit = opts.limit ?? 20;
  if (limit <= 0) return [];
  const [queryVec] = await provider.embed([query], identity.model, identity.dimensions);
  if (!queryVec) throw new Error("failed to generate the query embedding");
  if (queryVec.length !== identity.dimensions) {
    throw new Error(
      `query embedding dimension (${queryVec.length}) does not match the configured value (${identity.dimensions})`,
    );
  }

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

  const rows = db.transaction(() => {
    assertStoredEmbeddingIdentity(db, identity);
    const eligibleChunks = `SELECT c.id FROM chunks c
      JOIN documents d ON d.id = c.document_id
      JOIN buckets b ON b.id = d.bucket_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`;
    const total = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM chunks_vec WHERE chunk_id IN (${eligibleChunks})`)
        .get(...params) as { n: number }
    ).n;
    if (total === 0) return [];
    let k = Math.min(Math.max(limit * 4, 40), total);
    const statement = db.prepare(
      `WITH knn AS (
         SELECT chunk_id, distance FROM chunks_vec
         WHERE embedding MATCH ? AND k = ? AND chunk_id IN (${eligibleChunks})
       )
       SELECT d.id, d.doc_key, d.path, d.title, b.name AS bucket,
              (SELECT group_concat(t.path, ' ') FROM document_tags dt
                JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id) AS tag_paths,
              c.text AS chunk_text, knn.distance
       FROM knn
       JOIN chunks c ON c.id = knn.chunk_id
       JOIN documents d ON d.id = c.document_id
       JOIN buckets b ON b.id = d.bucket_id
       ORDER BY knn.distance`,
    );
    for (;;) {
      const candidates = statement.all(toBlob(queryVec), k, ...params) as VectorRow[];
      const uniqueDocuments = new Set(candidates.map((row) => row.id)).size;
      if (uniqueDocuments >= limit || k === total) return candidates;
      k = Math.min(k * 2, total);
    }
  })();

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
