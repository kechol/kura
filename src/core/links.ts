import type { Database } from "bun:sqlite";
import type { WikiLink } from "./wiki";

export interface RelatedDoc {
  key: string;
  title: string;
  bucket: string;
}

export interface Outlink {
  targetTitle: string;
  /** null なら未解決リンク */
  target: RelatedDoc | null;
}

export interface TwoHopGroup {
  /** 共通リンク先 */
  via: RelatedDoc;
  docs: RelatedDoc[];
}

const DOC_COLS = "d.doc_key AS key, d.title AS title, b.name AS bucket";

/** 本文から抽出したリンクを再同期し、Bucket 内タイトルと大文字小文字無視で解決する */
export function syncLinks(
  db: Database,
  sourceId: number,
  bucketId: number,
  links: WikiLink[],
): void {
  db.prepare("DELETE FROM links WHERE source_id = ?").run(sourceId);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO links (source_id, target_id, target_title)
     VALUES (?, (SELECT id FROM documents WHERE bucket_id = ? AND lower(title) = lower(?) AND id != ?), ?)`,
  );
  for (const link of links) {
    insert.run(sourceId, bucketId, link.target, sourceId, link.target);
  }
}

/**
 * 新規作成・リネームされたタイトルに一致する未解決リンクを自動解決する（SPEC §10.1）。
 * 解決対象は同一 Bucket 内のドキュメントからのリンクのみ。
 */
export function resolveUnresolvedLinks(
  db: Database,
  bucketId: number,
  title: string,
  targetId: number,
): number {
  const result = db
    .prepare(
      `UPDATE links SET target_id = ?
       WHERE target_id IS NULL AND lower(target_title) = lower(?)
       AND source_id IN (SELECT id FROM documents WHERE bucket_id = ?)
       AND source_id != ?`,
    )
    .run(targetId, title, bucketId, targetId);
  return result.changes;
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

/** 2ホップリンク: 共通のリンク先を持つ他ドキュメント（Cosense 方式、共通リンク先ごとにグループ化） */
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

/** 未解決リンク一覧（リンク先ドキュメントが存在しない）。タイトルごとにグループ化 */
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
