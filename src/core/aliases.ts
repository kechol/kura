import type { Database } from "bun:sqlite";
import { UsageError } from "./errors";
import { ftsRefreshAliases } from "./fts";
import { type ReresolveRow, reresolveLinks, resolveUnresolvedLinks } from "./links";
import { normalizeAlias } from "./wiki";

/**
 * Document aliases: alternate titles for wiki-link / resolveDoc resolution and
 * FTS matching (docs: document-notation.md). Part of the repository layer —
 * writes go through these functions so documents_fts and links stay in sync
 * (invariants R1). Case is preserved; comparison is case-insensitive.
 */

function requireAlias(raw: string): string {
  const alias = normalizeAlias(raw);
  if (alias === null) {
    throw new UsageError(
      `invalid alias: '${raw}' (must be non-empty, without [ ] | / or newlines)`,
    );
  }
  return alias;
}

function docRow(db: Database, docId: number): { bucket_id: number; path: string; title: string } {
  return db.prepare("SELECT bucket_id, path, title FROM documents WHERE id = ?").get(docId) as {
    bucket_id: number;
    path: string;
    title: string;
  };
}

/** Aliases of a document in creation order */
export function docAliases(db: Database, docId: number): string[] {
  const rows = db
    .prepare("SELECT alias FROM document_aliases WHERE document_id = ? ORDER BY id")
    .all(docId) as Array<{ alias: string }>;
  return rows.map((r) => r.alias);
}

/** Aliases for many documents in one query (the listDocuments batch path) */
export function docAliasesBatch(db: Database, docIds: number[]): Map<number, string[]> {
  const map = new Map<number, string[]>();
  if (docIds.length === 0) return map;
  const rows = db
    .prepare(
      `SELECT document_id, alias FROM document_aliases
       WHERE document_id IN (${docIds.map(() => "?").join(", ")})
       ORDER BY document_id, id`,
    )
    .all(...docIds) as Array<{ document_id: number; alias: string }>;
  for (const r of rows) {
    const list = map.get(r.document_id);
    if (list) list.push(r.alias);
    else map.set(r.document_id, [r.alias]);
  }
  return map;
}

/**
 * Add aliases. Entries equal to the document title or an existing alias
 * (case-insensitive) are skipped, so frontmatter round-trips stay idempotent.
 * Newly matching unresolved links self-heal in the same call. Returns the
 * aliases actually added.
 */
export function addAliasesToDoc(db: Database, docId: number, raws: string[]): string[] {
  return db.transaction(() => {
    const doc = docRow(db, docId);
    const added: string[] = [];
    const insert = db.prepare(
      `INSERT INTO document_aliases (document_id, alias)
       SELECT ?, ? WHERE NOT EXISTS (
         SELECT 1 FROM document_aliases WHERE document_id = ? AND lower(alias) = lower(?))`,
    );
    for (const raw of raws) {
      const alias = requireAlias(raw);
      if (alias.toLowerCase() === doc.title.toLowerCase()) continue;
      const result = insert.run(docId, alias, docId, alias);
      if (result.changes > 0) added.push(alias);
    }
    if (added.length > 0) {
      ftsRefreshAliases(db, docId);
      resolveUnresolvedLinks(db, doc.bucket_id, docId, doc.path, doc.title);
    }
    return added;
  })();
}

/**
 * Remove aliases (case-insensitive). Links that resolved through a removed
 * alias are re-resolved with the shared three-stage resolution — they either
 * find another home or go back to unresolved. Returns the number removed.
 */
export function removeAliasesFromDoc(db: Database, docId: number, raws: string[]): number {
  return db.transaction(() => {
    let removed = 0;
    const affected: string[] = [];
    const remove = db.prepare(
      "DELETE FROM document_aliases WHERE document_id = ? AND lower(alias) = lower(?)",
    );
    for (const raw of raws) {
      const alias = requireAlias(raw);
      const result = remove.run(docId, alias);
      if (result.changes > 0) {
        removed += result.changes;
        affected.push(alias.toLowerCase());
      }
    }
    if (removed > 0) {
      ftsRefreshAliases(db, docId);
      // Links that resolved through a removed alias find another home or unresolve
      const rows = db
        .prepare(
          `SELECT l.id, l.source_id, l.target_title, l.target_id, s.bucket_id
           FROM links l JOIN documents s ON s.id = l.source_id
           WHERE l.target_id = ? AND lower(l.target_title) IN (${affected.map(() => "?").join(", ")})`,
        )
        .all(docId, ...affected) as ReresolveRow[];
      reresolveLinks(db, rows);
    }
    return removed;
  })();
}

/**
 * Replace the alias set: remove what fell out of the new set, then add the
 * rest (addAliasesToDoc already skips existing entries). Wrapped in one
 * transaction so the replace is atomic (invariants R2).
 */
export function setAliasesForDoc(
  db: Database,
  docId: number,
  raws: string[],
): { added: string[]; removed: number } {
  return db.transaction(() => {
    const next = new Set(raws.map((r) => requireAlias(r).toLowerCase()));
    const toRemove = docAliases(db, docId).filter((a) => !next.has(a.toLowerCase()));
    const removed = toRemove.length > 0 ? removeAliasesFromDoc(db, docId, toRemove) : 0;
    const added = addAliasesToDoc(db, docId, raws);
    return { added, removed };
  })();
}
