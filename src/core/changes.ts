import type { Database } from "bun:sqlite";
import { toSqliteDatetime } from "./frontmatter";
import { stateAsOf } from "./revisions";

/**
 * Change feed (kura changes / MCP kura_changes): what happened in the store
 * since a point in time, so an agent resuming a session can catch up in one
 * call. Built on documents.updated_at plus the revision history — the
 * previous state comes from stateAsOf, so a pruned or coalesced-away
 * snapshot degrades to "changed, previous state unknown". Deletions are not
 * tracked (revisions die with their document, docs: data-model.md).
 */

export interface ChangeEntry {
  key: string;
  bucket: string;
  path: string;
  title: string;
  kind: "created" | "updated";
  createdAt: string;
  updatedAt: string;
  contentChanged: boolean;
  renamed: boolean;
  moved: boolean;
  /** State as of `since`; null when created in the window or the snapshot is gone */
  previousTitle: string | null;
  previousPath: string | null;
}

/**
 * Parse a --since value: relative (30m / 24h / 7d / 2w) or anything
 * Date-parsable (ISO 8601, YYYY-MM-DD). Returns SQLite datetime format,
 * or null when unparsable.
 */
export function parseSince(raw: string): string | null {
  const rel = raw.trim().match(/^(\d+)([mhdw])$/);
  if (rel) {
    const n = Number.parseInt(rel[1]!, 10);
    const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
      rel[2] as "m" | "h" | "d" | "w"
    ];
    return toSqliteDatetime(new Date(Date.now() - n * unitMs));
  }
  return toSqliteDatetime(raw);
}

export interface ChangesOptions {
  bucket?: string;
  limit?: number;
}

/** Documents created or updated after `since` (SQLite datetime), newest first */
export function changesSince(
  db: Database,
  since: string,
  opts: ChangesOptions = {},
): ChangeEntry[] {
  const where = ["d.updated_at > ?"];
  const params: Array<string | number> = [since];
  if (opts.bucket) {
    where.push("b.name = ?");
    params.push(opts.bucket);
  }
  params.push(opts.limit ?? 50);
  const rows = db
    .prepare(
      `SELECT d.id, d.doc_key, b.name AS bucket, d.path, d.title, d.content,
              d.created_at, d.updated_at
       FROM documents d JOIN buckets b ON b.id = d.bucket_id
       WHERE ${where.join(" AND ")}
       ORDER BY d.updated_at DESC LIMIT ?`,
    )
    .all(...params) as Array<{
    id: number;
    doc_key: string;
    bucket: string;
    path: string;
    title: string;
    content: string;
    created_at: string;
    updated_at: string;
  }>;

  return rows.map((row) => {
    const created = row.created_at > since;
    const prev = created ? null : stateAsOf(db, row.id, since);
    return {
      key: row.doc_key,
      bucket: row.bucket,
      path: row.path,
      title: row.title,
      kind: created ? ("created" as const) : ("updated" as const),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      contentChanged: created || (prev ? prev.content !== row.content : true),
      renamed: prev !== null && prev.title !== row.title,
      moved: prev !== null && prev.path !== row.path,
      previousTitle: prev?.title ?? null,
      previousPath: prev?.path ?? null,
    };
  });
}
