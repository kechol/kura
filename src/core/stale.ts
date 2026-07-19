import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";

export interface StaleDoc {
  key: string;
  title: string;
  /** Document path; '' = bucket root (for path-prefixed display) */
  path: string;
  bucket: string;
  daysSinceUpdate: number;
  accessCount: number;
  backlinkCount: number;
  /** 1.0 or higher marks a staleness candidate; higher values deserve review first */
  staleScore: number;
}

/**
 * Staleness score = f(days since last update, access_count, backlink count) (docs: self-healing.md).
 * Normalizes elapsed days by stale_days and dampens with usage.
 * The goal is to prompt review, not deletion (nothing is auto-deleted).
 */
export function staleScore(
  daysSinceUpdate: number,
  accessCount: number,
  backlinks: number,
  staleDays: number,
): number {
  const age = daysSinceUpdate / staleDays;
  const usage = (1 + Math.log1p(accessCount)) * (1 + 0.5 * backlinks);
  return age / usage;
}

export function staleDocuments(
  db: Database,
  config: KuraConfig,
  opts: { bucket?: string; limit?: number } = {},
): StaleDoc[] {
  const params: Array<string | number> = [`-${config.general.stale_days} days`];
  let where = "d.updated_at < datetime('now', ?)";
  if (opts.bucket) {
    where += " AND b.name = ?";
    params.push(opts.bucket);
  }
  const rows = db
    .prepare(
      `SELECT d.doc_key AS key, d.title, d.path, b.name AS bucket, d.access_count,
              CAST(julianday('now') - julianday(d.updated_at) AS REAL) AS days,
              (SELECT COUNT(*) FROM links l WHERE l.target_id = d.id) AS backlinks
       FROM documents d JOIN buckets b ON b.id = d.bucket_id
       WHERE ${where}`,
    )
    .all(...params) as Array<{
    key: string;
    title: string;
    path: string;
    bucket: string;
    access_count: number;
    days: number;
    backlinks: number;
  }>;

  const docs = rows
    .map((r) => ({
      key: r.key,
      title: r.title,
      path: r.path,
      bucket: r.bucket,
      daysSinceUpdate: Math.floor(r.days),
      accessCount: r.access_count,
      backlinkCount: r.backlinks,
      staleScore: staleScore(r.days, r.access_count, r.backlinks, config.general.stale_days),
    }))
    .filter((d) => d.staleScore >= 1)
    .sort((a, b) => b.staleScore - a.staleScore);
  return opts.limit !== undefined ? docs.slice(0, opts.limit) : docs;
}
