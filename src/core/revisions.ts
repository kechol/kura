import type { Database } from "bun:sqlite";
import { NotFoundError } from "./errors";

/**
 * Document revision history (docs: data-model.md). The repository layer
 * snapshots the state being replaced on every content / title / path change
 * (updateDocument in documents.ts); this module owns the table.
 */

/** Keep at most this many revisions per document (oldest pruned on insert) */
export const MAX_REVISIONS_PER_DOC = 100;

/** Consecutive saves within this window collapse into one revision per editing burst */
const COALESCE_MINUTES = 5;

export interface RevisionMeta {
  id: number;
  title: string;
  path: string;
  contentHash: string;
  /** The updated_at the state carried while it was current */
  savedAt: string;
  /** When the snapshot row was written */
  createdAt: string;
  bytes: number;
}

export interface Revision extends RevisionMeta {
  content: string;
}

export interface SnapshotInput {
  docId: number;
  title: string;
  path: string;
  content: string;
  contentHash: string;
  /** updated_at of the state being replaced */
  savedAt: string;
}

interface NewestRow {
  id: number;
  title: string;
  path: string;
  content_hash: string;
  created_at: string;
}

/**
 * Snapshot the state being replaced. Skipped when it equals the newest
 * revision (dedup) or when the newest revision was written inside the
 * coalesce window (autosave bursts collapse to the state before the burst).
 * Callers pass force for title / path changes, which always snapshot.
 * Returns whether a row was written. Runs inside the caller's save
 * transaction.
 */
export function snapshotRevision(
  db: Database,
  input: SnapshotInput,
  opts: { force?: boolean } = {},
): boolean {
  const newest = db
    .prepare(
      `SELECT id, title, path, content_hash, created_at FROM document_revisions
       WHERE document_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(input.docId) as NewestRow | null;

  if (
    newest &&
    newest.content_hash === input.contentHash &&
    newest.title === input.title &&
    newest.path === input.path
  ) {
    return false;
  }

  if (newest && opts.force !== true) {
    const { cutoff } = db
      .prepare(`SELECT datetime('now', '-${COALESCE_MINUTES} minutes') AS cutoff`)
      .get() as { cutoff: string };
    if (newest.created_at >= cutoff) return false;
  }

  db.prepare(
    `INSERT INTO document_revisions (document_id, title, path, content, content_hash, saved_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(input.docId, input.title, input.path, input.content, input.contentHash, input.savedAt);

  db.prepare(
    `DELETE FROM document_revisions WHERE document_id = ? AND id NOT IN (
       SELECT id FROM document_revisions WHERE document_id = ? ORDER BY id DESC LIMIT ?)`,
  ).run(input.docId, input.docId, MAX_REVISIONS_PER_DOC);
  return true;
}

const META_COLS =
  "id, title, path, content_hash AS contentHash, saved_at AS savedAt, created_at AS createdAt, length(content) AS bytes";

/** Revisions of a document, newest first */
export function listRevisions(db: Database, docId: number): RevisionMeta[] {
  return db
    .prepare(`SELECT ${META_COLS} FROM document_revisions WHERE document_id = ? ORDER BY id DESC`)
    .all(docId) as RevisionMeta[];
}

export function getRevision(db: Database, docId: number, revisionId: number): Revision {
  const row = db
    .prepare(
      `SELECT ${META_COLS}, content FROM document_revisions WHERE document_id = ? AND id = ?`,
    )
    .get(docId, revisionId) as Revision | null;
  if (!row) throw new NotFoundError(`revision not found: r${revisionId}`);
  return row;
}

/**
 * Lean point-in-time lookup for the change feed: title / path / content_hash
 * of the newest revision at or before asOf, without transferring bodies.
 * (The change feed only compares hashes — see src/core/changes.ts.)
 */
export function revisionMetaAsOf(
  db: Database,
  docId: number,
  asOf: string,
): { title: string; path: string; contentHash: string } | null {
  return db
    .prepare(
      `SELECT title, path, content_hash AS contentHash FROM document_revisions
       WHERE document_id = ? AND saved_at <= ? ORDER BY saved_at DESC, id DESC LIMIT 1`,
    )
    .get(docId, asOf) as { title: string; path: string; contentHash: string } | null;
}

export interface DocState {
  source: "current" | "revision";
  revisionId?: number;
  title: string;
  path: string;
  content: string;
  /** When this state became current */
  savedAt: string;
}

/**
 * The document's state as of a point in time (kura get --as-of): the newest
 * state — current row or revision — whose saved_at is <= asOf. null when the
 * document has no recorded state that old (created later, or the snapshot
 * was pruned).
 */
export function stateAsOf(db: Database, docId: number, asOf: string): DocState | null {
  const current = db
    .prepare("SELECT title, path, content, updated_at FROM documents WHERE id = ?")
    .get(docId) as { title: string; path: string; content: string; updated_at: string } | null;
  if (!current) throw new NotFoundError(`document not found: id=${docId}`);
  if (current.updated_at <= asOf) {
    return {
      source: "current",
      title: current.title,
      path: current.path,
      content: current.content,
      savedAt: current.updated_at,
    };
  }
  const rev = db
    .prepare(
      `SELECT id, title, path, content, saved_at FROM document_revisions
       WHERE document_id = ? AND saved_at <= ? ORDER BY saved_at DESC, id DESC LIMIT 1`,
    )
    .get(docId, asOf) as {
    id: number;
    title: string;
    path: string;
    content: string;
    saved_at: string;
  } | null;
  if (!rev) return null;
  return {
    source: "revision",
    revisionId: rev.id,
    title: rev.title,
    path: rev.path,
    content: rev.content,
    savedAt: rev.saved_at,
  };
}
