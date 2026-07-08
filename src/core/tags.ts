import type { Database } from "bun:sqlite";
import { ConflictError, UsageError } from "./errors";
import { ftsRefreshTags } from "./fts";
import { normalizeTagPath } from "./wiki";

export type TagSource = "manual" | "auto";

export interface TagEntry {
  path: string;
  /** Number of documents directly tagged */
  count: number;
}

function requireNormalized(raw: string): string {
  const path = normalizeTagPath(raw);
  if (!path) throw new UsageError(`invalid tag: '${raw}'`);
  return path;
}

export function getOrCreateTag(db: Database, rawPath: string): number {
  const path = requireNormalized(rawPath);
  db.prepare("INSERT INTO tags (path) VALUES (?) ON CONFLICT(path) DO NOTHING").run(path);
  const row = db.prepare("SELECT id FROM tags WHERE path = ?").get(path) as { id: number };
  return row.id;
}

export function listTags(db: Database): TagEntry[] {
  return db
    .prepare(
      `SELECT t.path, COUNT(dt.document_id) AS count
       FROM tags t LEFT JOIN document_tags dt ON dt.tag_id = t.id
       GROUP BY t.id ORDER BY t.path`,
    )
    .all() as TagEntry[];
}

export function docTags(db: Database, docId: number): string[] {
  const rows = db
    .prepare(
      `SELECT t.path FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
       WHERE dt.document_id = ? ORDER BY t.path`,
    )
    .all(docId) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

/** Add tags and refresh the FTS tags column. Returns the normalized tags that were actually added */
export function addTagsToDoc(
  db: Database,
  docId: number,
  rawPaths: string[],
  source: TagSource = "manual",
): string[] {
  const added: string[] = [];
  for (const raw of rawPaths) {
    const path = requireNormalized(raw);
    const tagId = getOrCreateTag(db, path);
    const result = db
      .prepare(
        "INSERT INTO document_tags (document_id, tag_id, source) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
      )
      .run(docId, tagId, source);
    if (result.changes > 0) added.push(path);
  }
  if (added.length > 0) ftsRefreshTags(db, docId);
  return added;
}

/** Remove tags and refresh FTS. Returns the number actually removed */
export function removeTagsFromDoc(db: Database, docId: number, rawPaths: string[]): number {
  let removed = 0;
  for (const raw of rawPaths) {
    const path = requireNormalized(raw);
    const result = db
      .prepare(
        `DELETE FROM document_tags WHERE document_id = ?
         AND tag_id = (SELECT id FROM tags WHERE path = ?)`,
      )
      .run(docId, path);
    removed += result.changes;
  }
  if (removed > 0) ftsRefreshTags(db, docId);
  return removed;
}

export interface RenameTagResult {
  /** Old tag paths that were moved or merged */
  moved: string[];
  /** Whether a merge occurred */
  merged: boolean;
  /** Documents whose tag sets changed (FTS already refreshed) */
  affectedDocs: number[];
}

/**
 * Rename/merge a tag (descendant tags move together, docs: cli-reference.md).
 * When the destination path already exists, re-point document_tags and merge.
 */
export function renameTag(db: Database, oldRaw: string, newRaw: string): RenameTagResult {
  const oldPath = requireNormalized(oldRaw);
  const newPath = requireNormalized(newRaw);
  if (oldPath === newPath) throw new ConflictError(`tag paths are identical: ${oldPath}`);
  if (newPath.startsWith(`${oldPath}/`)) {
    throw new ConflictError(`cannot move tag under its own descendant: ${oldPath} -> ${newPath}`);
  }

  const targets = db
    .prepare("SELECT id, path FROM tags WHERE path = ? OR path LIKE ? || '/%' ORDER BY path")
    .all(oldPath, oldPath) as Array<{ id: number; path: string }>;
  if (targets.length === 0) {
    throw new ConflictError(`tag not found: ${oldPath}`);
  }

  const moved: string[] = [];
  let merged = false;
  const affected = new Set<number>();

  for (const tag of targets) {
    const suffix = tag.path.slice(oldPath.length);
    const destPath = `${newPath}${suffix}`;
    const existing = db.prepare("SELECT id FROM tags WHERE path = ?").get(destPath) as {
      id: number;
    } | null;

    const docRows = db
      .prepare("SELECT document_id FROM document_tags WHERE tag_id = ?")
      .all(tag.id) as Array<{ document_id: number }>;
    for (const r of docRows) affected.add(r.document_id);

    if (existing && existing.id !== tag.id) {
      // Merge: re-point to the existing tag (ignoring duplicates) and delete the old tag
      merged = true;
      db.prepare("UPDATE OR IGNORE document_tags SET tag_id = ? WHERE tag_id = ?").run(
        existing.id,
        tag.id,
      );
      db.prepare("DELETE FROM document_tags WHERE tag_id = ?").run(tag.id);
      db.prepare("DELETE FROM tags WHERE id = ?").run(tag.id);
    } else {
      db.prepare("UPDATE tags SET path = ? WHERE id = ?").run(destPath, tag.id);
    }
    moved.push(tag.path);
  }

  for (const docId of affected) ftsRefreshTags(db, docId);
  return { moved, merged, affectedDocs: [...affected] };
}

/** Delete tags not attached to any document */
export function gcTags(db: Database): string[] {
  const orphans = db
    .prepare(
      `SELECT path FROM tags t
       WHERE NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.tag_id = t.id)
       ORDER BY path`,
    )
    .all() as Array<{ path: string }>;
  db.exec(
    "DELETE FROM tags WHERE NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.tag_id = tags.id)",
  );
  return orphans.map((r) => r.path);
}

export interface TagTreeNode {
  segment: string;
  path: string;
  /** Direct tag count (0 for intermediate nodes without a tag entity) */
  count: number;
  /** Total count including descendants */
  total: number;
  children: TagTreeNode[];
}

/** Build the tag list into a hierarchy tree (for --tree display) */
export function buildTagTree(entries: TagEntry[]): TagTreeNode[] {
  const roots: TagTreeNode[] = [];
  const index = new Map<string, TagTreeNode>();

  const ensure = (path: string): TagTreeNode => {
    const existing = index.get(path);
    if (existing) return existing;
    const idx = path.lastIndexOf("/");
    const node: TagTreeNode = {
      segment: idx === -1 ? path : path.slice(idx + 1),
      path,
      count: 0,
      total: 0,
      children: [],
    };
    index.set(path, node);
    if (idx === -1) {
      roots.push(node);
    } else {
      ensure(path.slice(0, idx)).children.push(node);
    }
    return node;
  };

  for (const e of entries) {
    ensure(e.path).count = e.count;
  }
  const sum = (node: TagTreeNode): number => {
    node.total = node.count + node.children.reduce((acc, c) => acc + sum(c), 0);
    return node.total;
  };
  for (const r of roots) sum(r);
  return roots;
}
