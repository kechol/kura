import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import { getMeta } from "./db";
import { UNFILED_WHERE, UNTAGGED_WHERE, UNTRIAGED_WHERE } from "./documents";

export interface KuraStats {
  documents: number;
  buckets: Array<{ name: string; documents: number }>;
  tags: number;
  chunks: number;
  embeddedChunks: number;
  /** 0-1; 1 when there are no chunks */
  embeddingCoverage: number;
  staleDocuments: number;
  /** Documents at the bucket root (path = '') */
  unfiled: number;
  /** Documents with no tags */
  untagged: number;
  /** Documents in the triage backlog: (unfiled OR untagged) still awaiting a triage pass */
  triageBacklog: number;
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

  // Backlog counts in one scan: the untagged anti-join is evaluated once, and the
  // triage backlog reuses the same predicates (docs: self-healing.md).
  const backlog = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN ${UNFILED_WHERE} THEN 1 ELSE 0 END), 0) AS unfiled,
         COALESCE(SUM(CASE WHEN ${UNTAGGED_WHERE} THEN 1 ELSE 0 END), 0) AS untagged,
         COALESCE(SUM(CASE WHEN (${UNFILED_WHERE} OR ${UNTAGGED_WHERE}) AND ${UNTRIAGED_WHERE}
           THEN 1 ELSE 0 END), 0) AS triage_backlog
       FROM documents d`,
    )
    .get() as { unfiled: number; untagged: number; triage_backlog: number };

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
    unfiled: backlog.unfiled,
    untagged: backlog.untagged,
    triageBacklog: backlog.triage_backlog,
    unresolvedLinks: count(db, "SELECT COUNT(*) AS n FROM links WHERE target_id IS NULL"),
    dbSizeBytes: size.n,
    tokenizer: getMeta(db, "fts_tokenizer") ?? "unknown",
    embeddingModel: getMeta(db, "embedding_model"),
  };
}
