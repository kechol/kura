import type { Database } from "bun:sqlite";
import { joinDocPath, type WikiLink } from "./wiki";

export interface RelatedDoc {
  key: string;
  title: string;
  bucket: string;
}

export interface Outlink {
  targetTitle: string;
  /** null means the link is unresolved */
  target: RelatedDoc | null;
}

export interface TwoHopGroup {
  /** Shared link target */
  via: RelatedDoc;
  docs: RelatedDoc[];
}

const DOC_COLS = "d.doc_key AS key, d.title AS title, b.name AS bucket";

/** SQL spelling of a document's computed full path (docs: document-notation.md) */
export function fullPathSql(alias = ""): string {
  const p = alias === "" ? "" : `${alias}.`;
  return `CASE WHEN ${p}path = '' THEN ${p}title ELSE ${p}path || '/' || ${p}title END`;
}

/**
 * Three-stage, bucket-scoped, case-insensitive wiki-link resolution
 * (docs: document-notation.md):
 *   1. exact computed-full-path match (unique per bucket by construction)
 *   2. title match, resolved only when exactly one candidate exists
 *   3. alias match, resolved only when exactly one document carries the alias
 * Returns null when unresolved or ambiguous. The explicit LIMIT 2 count guards
 * replace the old scalar subquery, which silently picked an arbitrary row
 * when several titles matched. A stage that matches at all (even ambiguously)
 * ends the search — an ambiguous title never falls through to aliases.
 */
export function resolveLinkTarget(
  db: Database,
  bucketId: number,
  ref: string,
  excludeId: number,
): number | null {
  const byFull = db
    .prepare(
      `SELECT id FROM documents
       WHERE bucket_id = ? AND id != ? AND lower(${fullPathSql()}) = lower(?) LIMIT 2`,
    )
    .all(bucketId, excludeId, ref) as Array<{ id: number }>;
  if (byFull.length > 0) return byFull.length === 1 ? (byFull[0]?.id ?? null) : null;
  const byTitle = db
    .prepare(
      "SELECT id FROM documents WHERE bucket_id = ? AND id != ? AND lower(title) = lower(?) LIMIT 2",
    )
    .all(bucketId, excludeId, ref) as Array<{ id: number }>;
  if (byTitle.length > 0) return byTitle.length === 1 ? (byTitle[0]?.id ?? null) : null;
  const byAlias = db
    .prepare(
      `SELECT DISTINCT da.document_id AS id FROM document_aliases da
       JOIN documents d ON d.id = da.document_id
       WHERE d.bucket_id = ? AND da.document_id != ? AND lower(da.alias) = lower(?) LIMIT 2`,
    )
    .all(bucketId, excludeId, ref) as Array<{ id: number }>;
  return byAlias.length === 1 ? (byAlias[0]?.id ?? null) : null;
}

/** Re-sync links extracted from the body, resolving each target via resolveLinkTarget */
export function syncLinks(
  db: Database,
  sourceId: number,
  bucketId: number,
  links: WikiLink[],
): void {
  db.prepare("DELETE FROM links WHERE source_id = ?").run(sourceId);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO links (source_id, target_id, target_title) VALUES (?, ?, ?)",
  );
  for (const link of links) {
    insert.run(sourceId, resolveLinkTarget(db, bucketId, link.target, sourceId), link.target);
  }
}

/**
 * Auto-resolve unresolved links matching a newly created, renamed, moved, or
 * newly aliased document (docs: self-healing.md). The title, the full-path
 * spelling, and the document's aliases are considered; ambiguous short-form
 * references stay unresolved. Only links from documents in the same bucket
 * are resolved.
 */
export function resolveUnresolvedLinks(
  db: Database,
  bucketId: number,
  docId: number,
  path: string,
  title: string,
): number {
  const full = joinDocPath(path, title);
  const rows = db
    .prepare(
      `SELECT l.id, l.source_id, l.target_title
       FROM links l
       JOIN documents s ON s.id = l.source_id
       WHERE l.target_id IS NULL AND s.bucket_id = ? AND l.source_id != ?
         AND (lower(l.target_title) = lower(?) OR lower(l.target_title) = lower(?)
              OR lower(l.target_title) IN (
                SELECT lower(alias) FROM document_aliases WHERE document_id = ?))`,
    )
    .all(bucketId, docId, title, full, docId) as Array<{
    id: number;
    source_id: number;
    target_title: string;
  }>;
  let changes = 0;
  const update = db.prepare("UPDATE links SET target_id = ? WHERE id = ?");
  for (const row of rows) {
    const target = resolveLinkTarget(db, bucketId, row.target_title, row.source_id);
    if (target !== null) {
      update.run(target, row.id);
      changes++;
    }
  }
  return changes;
}

export interface ReresolveRow {
  id: number;
  source_id: number;
  target_title: string;
  /** Current target_id of the row (null when unresolved) */
  target_id: number | null;
  bucket_id: number;
}

/**
 * Re-run the three-stage resolution for the given link rows, updating those
 * whose target changed. Shared by alias removal (src/core/aliases.ts) and
 * doctor's bulk re-resolution. Returns how many rows changed.
 */
export function reresolveLinks(db: Database, rows: ReresolveRow[]): number {
  const update = db.prepare("UPDATE links SET target_id = ? WHERE id = ?");
  let changes = 0;
  for (const row of rows) {
    const target = resolveLinkTarget(db, row.bucket_id, row.target_title, row.source_id);
    if (target !== row.target_id) {
      update.run(target, row.id);
      changes++;
    }
  }
  return changes;
}

export function outlinks(db: Database, docId: number): Outlink[] {
  const rows = db
    .prepare(
      `SELECT l.target_title, d.doc_key AS key, d.title AS title, b.name AS bucket
       FROM links l
       LEFT JOIN documents d ON d.id = l.target_id
       LEFT JOIN buckets b ON b.id = d.bucket_id
       WHERE l.source_id = ? ORDER BY l.id`,
    )
    .all(docId) as Array<{
    target_title: string;
    key: string | null;
    title: string | null;
    bucket: string | null;
  }>;
  return rows.map((r) => ({
    targetTitle: r.target_title,
    target: r.key ? { key: r.key, title: r.title ?? "", bucket: r.bucket ?? "" } : null,
  }));
}

export function backlinks(db: Database, docId: number): RelatedDoc[] {
  return db
    .prepare(
      `SELECT DISTINCT ${DOC_COLS}
       FROM links l
       JOIN documents d ON d.id = l.source_id
       JOIN buckets b ON b.id = d.bucket_id
       WHERE l.target_id = ? ORDER BY d.title`,
    )
    .all(docId) as RelatedDoc[];
}

/** Two-hop links: other documents sharing a link target (grouped per shared target) */
export function twoHopLinks(db: Database, docId: number): TwoHopGroup[] {
  const rows = db
    .prepare(
      `SELECT via.doc_key AS via_key, via.title AS via_title, vb.name AS via_bucket,
              d.doc_key AS key, d.title AS title, b.name AS bucket
       FROM links l1
       JOIN documents via ON via.id = l1.target_id
       JOIN buckets vb ON vb.id = via.bucket_id
       JOIN links l2 ON l2.target_id = l1.target_id AND l2.source_id != l1.source_id
       JOIN documents d ON d.id = l2.source_id
       JOIN buckets b ON b.id = d.bucket_id
       WHERE l1.source_id = ?
         AND d.id != ?
         AND d.id NOT IN (
           SELECT target_id FROM links WHERE source_id = ? AND target_id IS NOT NULL
         )
       ORDER BY via.title, d.title`,
    )
    .all(docId, docId, docId) as Array<{
    via_key: string;
    via_title: string;
    via_bucket: string;
    key: string;
    title: string;
    bucket: string;
  }>;

  const groups = new Map<string, TwoHopGroup>();
  for (const r of rows) {
    let group = groups.get(r.via_key);
    if (!group) {
      group = { via: { key: r.via_key, title: r.via_title, bucket: r.via_bucket }, docs: [] };
      groups.set(r.via_key, group);
    }
    if (!group.docs.some((d) => d.key === r.key)) {
      group.docs.push({ key: r.key, title: r.title, bucket: r.bucket });
    }
  }
  return [...groups.values()];
}

export interface BrokenLink {
  targetTitle: string;
  sources: RelatedDoc[];
}

/** List unresolved links (target document does not exist), grouped by title */
export function brokenLinks(db: Database, bucketId?: number): BrokenLink[] {
  const rows = db
    .prepare(
      `SELECT l.target_title, ${DOC_COLS}
       FROM links l
       JOIN documents d ON d.id = l.source_id
       JOIN buckets b ON b.id = d.bucket_id
       WHERE l.target_id IS NULL ${bucketId ? "AND d.bucket_id = ?" : ""}
       ORDER BY lower(l.target_title), d.title`,
    )
    .all(...(bucketId ? [bucketId] : [])) as Array<{
    target_title: string;
    key: string;
    title: string;
    bucket: string;
  }>;

  const groups = new Map<string, BrokenLink>();
  for (const r of rows) {
    const key = r.target_title.toLowerCase();
    let group = groups.get(key);
    if (!group) {
      group = { targetTitle: r.target_title, sources: [] };
      groups.set(key, group);
    }
    group.sources.push({ key: r.key, title: r.title, bucket: r.bucket });
  }
  return [...groups.values()];
}
