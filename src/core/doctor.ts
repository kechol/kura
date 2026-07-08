import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import { type FtsTokenizer, getMeta, setMeta } from "./db";
import { sha256Hex, updateDocument } from "./documents";

export interface FixReport {
  action: string;
  detail: string;
}

function count(db: Database, sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

const FTS_REINSERT = `
  INSERT INTO documents_fts (rowid, title, content, tags)
  SELECT d.id, d.title, d.content,
         COALESCE((SELECT group_concat(t.path, ' ') FROM document_tags dt
                   JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id), '')
  FROM documents d`;

/** Detect a row-count mismatch between documents_fts and documents, then rebuild (SPEC §10.2) */
export function rebuildFtsIfNeeded(db: Database): FixReport | null {
  const docs = count(db, "SELECT COUNT(*) AS n FROM documents");
  const fts = count(db, "SELECT COUNT(*) AS n FROM documents_fts");
  if (docs === fts) return null;
  db.transaction(() => {
    db.exec("DELETE FROM documents_fts");
    db.exec(FTS_REINSERT);
  })();
  return { action: "fts-rebuild", detail: `resolved mismatch: documents=${docs} / fts=${fts}` };
}

/** Recreate the FTS table with the given tokenizer (reindex, e.g. trigram to vaporetto) */
export function retokenizeFts(db: Database, tokenizer: FtsTokenizer): FixReport {
  db.transaction(() => {
    db.exec("DROP TABLE documents_fts");
    db.exec(
      `CREATE VIRTUAL TABLE documents_fts USING fts5(title, content, tags, tokenize='${tokenizer}')`,
    );
    db.exec(FTS_REINSERT);
    setMeta(db, "fts_tokenizer", tokenizer);
  })();
  return { action: "fts-retokenize", detail: `rebuilt FTS with ${tokenizer}` };
}

/** GC orphaned chunks / vec rows (counted up front because vec0 reports inaccurate changes) */
export function gcOrphans(db: Database): FixReport | null {
  const orphanChunks = count(
    db,
    "SELECT COUNT(*) AS n FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)",
  );
  if (orphanChunks > 0) {
    db.exec("DELETE FROM chunks WHERE document_id NOT IN (SELECT id FROM documents)");
  }
  const orphanVec = count(
    db,
    "SELECT COUNT(*) AS n FROM chunks_vec WHERE chunk_id NOT IN (SELECT id FROM chunks)",
  );
  if (orphanVec > 0) {
    db.exec("DELETE FROM chunks_vec WHERE chunk_id NOT IN (SELECT id FROM chunks)");
  }
  if (orphanChunks === 0 && orphanVec === 0) return null;
  return {
    action: "gc-orphans",
    detail: `deleted ${orphanChunks} orphaned chunk(s) / ${orphanVec} orphaned vector(s)`,
  };
}

/** Recompute content_hash values that no longer match the content, then re-chunk (updateDocument syncs on hash difference) */
export function fixContentHashes(db: Database): FixReport | null {
  const rows = db
    .prepare("SELECT id, content, content_hash, updated_at FROM documents")
    .all() as Array<{
    id: number;
    content: string;
    content_hash: string;
    updated_at: string;
  }>;
  let fixed = 0;
  for (const row of rows) {
    if (sha256Hex(row.content) === row.content_hash) continue;
    updateDocument(db, row.id, { content: row.content, updatedAt: row.updated_at });
    fixed++;
  }
  return fixed > 0
    ? {
        action: "content-hash",
        detail: `recomputed content_hash and re-chunked ${fixed} document(s)`,
      }
    : null;
}

/** Re-resolve all unresolved links in bulk (within the same bucket, case-insensitive, SPEC §10.1) */
export function resolveAllUnresolvedLinks(db: Database): FixReport | null {
  const result = db
    .prepare(
      `UPDATE links SET target_id = (
         SELECT d.id FROM documents d
         JOIN documents s ON s.id = links.source_id
         WHERE d.bucket_id = s.bucket_id
           AND lower(d.title) = lower(links.target_title)
           AND d.id != links.source_id
       )
       WHERE target_id IS NULL
         AND EXISTS (
           SELECT 1 FROM documents d
           JOIN documents s ON s.id = links.source_id
           WHERE d.bucket_id = s.bucket_id
             AND lower(d.title) = lower(links.target_title)
             AND d.id != links.source_id
         )`,
    )
    .run();
  return result.changes > 0
    ? { action: "resolve-links", detail: `resolved ${result.changes} unresolved link(s)` }
    : null;
}

/** Detect embedding model/dimension changes, recreate chunks_vec, and mark all chunks for re-embedding (SPEC §3.2) */
export function recreateVecIfModelChanged(db: Database, config: KuraConfig): FixReport | null {
  const storedDims = getMeta(db, "embedding_dimensions");
  const storedModel = getMeta(db, "embedding_model");
  const dims = config.llm.models.embedding_dimensions;
  const model = config.llm.models.embedding;
  if (storedDims === String(dims) && storedModel === model) return null;

  db.transaction(() => {
    db.exec("DROP TABLE chunks_vec");
    db.exec(
      `CREATE VIRTUAL TABLE chunks_vec USING vec0(chunk_id INTEGER PRIMARY KEY, embedding float[${dims}])`,
    );
    db.exec("UPDATE chunks SET embedded_at = NULL");
    setMeta(db, "embedding_dimensions", String(dims));
    setMeta(db, "embedding_model", model);
  })();
  return {
    action: "vec-recreate",
    detail: `detected embedding config change (${storedModel}/${storedDims} -> ${model}/${dims}); recreated chunks_vec. Run 'kura embed' to regenerate`,
  };
}
