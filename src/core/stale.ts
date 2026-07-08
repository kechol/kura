import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";

export interface StaleDoc {
  key: string;
  title: string;
  bucket: string;
  daysSinceUpdate: number;
  accessCount: number;
  backlinkCount: number;
  /** 1.0 以上で陳腐化候補。大きいほど優先的にレビューすべき */
  staleScore: number;
}

/**
 * 陳腐化スコア = f(最終更新からの日数, access_count, バックリンク数)（SPEC §10.4）。
 * 経過日数を stale_days で正規化し、参照が多いほど減衰させる。
 * 削除ではなくレビュー促進が目的（自動削除はしない）。
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
      `SELECT d.doc_key AS key, d.title, b.name AS bucket, d.access_count,
              CAST(julianday('now') - julianday(d.updated_at) AS REAL) AS days,
              (SELECT COUNT(*) FROM links l WHERE l.target_id = d.id) AS backlinks
       FROM documents d JOIN buckets b ON b.id = d.bucket_id
       WHERE ${where}`,
    )
    .all(...params) as Array<{
    key: string;
    title: string;
    bucket: string;
    access_count: number;
    days: number;
    backlinks: number;
  }>;

  const docs = rows
    .map((r) => ({
      key: r.key,
      title: r.title,
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
