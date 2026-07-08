import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import { getMeta } from "./db";

export interface KuraStats {
  documents: number;
  buckets: Array<{ name: string; documents: number }>;
  tags: number;
  chunks: number;
  embeddedChunks: number;
  /** 0〜1。チャンクが無ければ 1 */
  embeddingCoverage: number;
  staleDocuments: number;
  unresolvedLinks: number;
  dbSizeBytes: number;
  tokenizer: string;
  embeddingModel: string | null;
}

function count(db: Database, sql: string, ...params: Array<string | number>): number {
  return (db.prepare(sql).get(...params) as { n: number }).n;
}

export function collectStats(db: Database, config: KuraConfig): KuraStats {
  const documents = count(db, "SELECT COUNT(*) AS n FROM documents");
  const chunks = count(db, "SELECT COUNT(*) AS n FROM chunks");
  const embeddedChunks = count(
    db,
    "SELECT COUNT(*) AS n FROM chunks WHERE embedded_at IS NOT NULL",
  );
  const size = db
    .prepare("SELECT (SELECT * FROM pragma_page_count()) * (SELECT * FROM pragma_page_size()) AS n")
    .get() as { n: number };

  return {
    documents,
    buckets: db
      .prepare(
        `SELECT b.name, COUNT(d.id) AS documents
         FROM buckets b LEFT JOIN documents d ON d.bucket_id = b.id
         GROUP BY b.id ORDER BY b.name`,
      )
      .all() as Array<{ name: string; documents: number }>,
    tags: count(db, "SELECT COUNT(*) AS n FROM tags"),
    chunks,
    embeddedChunks,
    embeddingCoverage: chunks === 0 ? 1 : embeddedChunks / chunks,
    staleDocuments: count(
      db,
      "SELECT COUNT(*) AS n FROM documents WHERE updated_at < datetime('now', ?)",
      `-${config.general.stale_days} days`,
    ),
    unresolvedLinks: count(db, "SELECT COUNT(*) AS n FROM links WHERE target_id IS NULL"),
    dbSizeBytes: size.n,
    tokenizer: getMeta(db, "fts_tokenizer") ?? "unknown",
    embeddingModel: getMeta(db, "embedding_model"),
  };
}
