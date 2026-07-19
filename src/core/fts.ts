import type { Database } from "bun:sqlite";

/**
 * Sync helpers for documents_fts. rowid = documents.id.
 * Called by the repository layer inside the same transaction, not by SQL triggers
 * (the tags column is composed at write time).
 */

function currentTagsText(db: Database, docId: number): string {
  const row = db
    .prepare(
      `SELECT group_concat(t.path, ' ') AS tags
       FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
       WHERE dt.document_id = ?`,
    )
    .get(docId) as { tags: string | null };
  return row.tags ?? "";
}

function currentAliasesText(db: Database, docId: number): string {
  const row = db
    .prepare(
      "SELECT group_concat(alias, ' ') AS aliases FROM document_aliases WHERE document_id = ?",
    )
    .get(docId) as { aliases: string | null };
  return row.aliases ?? "";
}

export function ftsUpsert(db: Database, doc: { id: number; title: string; content: string }): void {
  db.prepare("DELETE FROM documents_fts WHERE rowid = ?").run(doc.id);
  db.prepare(
    "INSERT INTO documents_fts (rowid, title, content, tags, aliases) VALUES (?, ?, ?, ?, ?)",
  ).run(
    doc.id,
    doc.title,
    doc.content,
    currentTagsText(db, doc.id),
    currentAliasesText(db, doc.id),
  );
}

export function ftsDelete(db: Database, docId: number): void {
  db.prepare("DELETE FROM documents_fts WHERE rowid = ?").run(docId);
}

/** Refresh only the tags column after tag operations (documents itself is unchanged) */
export function ftsRefreshTags(db: Database, docId: number): void {
  db.prepare("UPDATE documents_fts SET tags = ? WHERE rowid = ?").run(
    currentTagsText(db, docId),
    docId,
  );
}

/** Refresh only the aliases column after alias operations (documents itself is unchanged) */
export function ftsRefreshAliases(db: Database, docId: number): void {
  db.prepare("UPDATE documents_fts SET aliases = ? WHERE rowid = ?").run(
    currentAliasesText(db, docId),
    docId,
  );
}
