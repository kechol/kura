import type { Database } from "bun:sqlite";
import type { KuraConfig } from "../config";
import type { LLMProvider } from "../llm/provider";
import type { SearchHit } from "./types";

export interface VectorOptions {
  bucket?: string;
  tag?: string;
  limit?: number;
}

/** これ以下の未 embedding チャンク数なら検索前に自動バックフィルする（SPEC §5.3） */
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
  /** true で全チャンク強制再生成（`kura embed --all`） */
  all?: boolean;
  onProgress?: (done: number, total: number) => void;
}

export interface BackfillResult {
  embedded: number;
  total: number;
}

/**
 * 未 embedding チャンクのバックフィル。embedded_at ベースで中断再開可能。
 * バッチごとにトランザクションで chunks_vec / embedded_at を更新する。
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
            `embedding の次元 (${vec.length}) が設定 (${dimensions}) と一致しません。config の embedding_dimensions を見直して 'kura embed --all' を実行してください`,
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
 * 検索前の embedding 整合チェック。未処理が少なければ自動バックフィルし、
 * 多ければ警告文字列を返して検索は既存 embedding で続行する（SPEC §5.3）。
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
  return `未 embedding のチャンクが ${pending} 件あります。検索結果が不完全な可能性があります（'kura embed' を実行してください）`;
}

/** チャンク全文（rerank 用）を含むベクトル検索の内部結果 */
export interface VectorHitDetail {
  hit: SearchHit;
  chunkText: string;
}

function chunkSnippet(text: string): string {
  // コンテキストヘッダ（先頭行）を除いた本文の先頭を返す
  const body = text
    .replace(/^# [^\n]*\n+/, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return body.length > 160 ? `${body.slice(0, 160)}…` : body;
}

/** クエリ embedding → chunks_vec KNN → ドキュメント単位に最良チャンクで集約（SPEC §5.1） */
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
  if (!queryVec) throw new Error("クエリの embedding 生成に失敗しました");

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
       SELECT d.id, d.doc_key, d.title, b.name AS bucket,
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
    title: string;
    bucket: string;
    tag_paths: string | null;
    chunk_text: string;
    distance: number;
  }>;

  // ドキュメント単位に最良（最小距離）チャンクで集約
  const byDoc = new Map<number, VectorHitDetail>();
  for (const row of rows) {
    if (byDoc.has(row.id)) continue;
    byDoc.set(row.id, {
      chunkText: row.chunk_text,
      hit: {
        docId: row.id,
        key: row.doc_key,
        title: row.title,
        bucket: row.bucket,
        tags: row.tag_paths ? row.tag_paths.split(" ") : [],
        score: 1 / (1 + row.distance),
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
