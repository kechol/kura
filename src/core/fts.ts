import type { Database } from "bun:sqlite";

/**
 * documents_fts の同期ヘルパー。rowid = documents.id。
 * SQL トリガーではなくリポジトリ層が同一トランザクション内で呼ぶ（tags 列の合成があるため）。
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

export function ftsUpsert(db: Database, doc: { id: number; title: string; content: string }): void {
  db.prepare("DELETE FROM documents_fts WHERE rowid = ?").run(doc.id);
  db.prepare("INSERT INTO documents_fts (rowid, title, content, tags) VALUES (?, ?, ?, ?)").run(
    doc.id,
    doc.title,
    doc.content,
    currentTagsText(db, doc.id),
  );
}

export function ftsDelete(db: Database, docId: number): void {
  db.prepare("DELETE FROM documents_fts WHERE rowid = ?").run(docId);
}

/** タグ操作後に tags 列のみ更新する（documents 本体は変更なし） */
export function ftsRefreshTags(db: Database, docId: number): void {
  db.prepare("UPDATE documents_fts SET tags = ? WHERE rowid = ?").run(
    currentTagsText(db, docId),
    docId,
  );
}
