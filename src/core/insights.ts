import type { Database } from "bun:sqlite";
import { requireBucket } from "./buckets";
import type { KuraConfig } from "./config";
import { listUnfiledDocuments } from "./filing";
import { auditTags, type TagMergeCandidate, untaggedDocuments } from "./gardening";
import { brokenLinks } from "./links";

/**
 * Read-only tidying insights for one bucket (docs: self-healing.md). Everything here
 * reuses an existing core query; nothing is repaired automatically — the browser lists
 * the findings and points at the CLI command that fixes them.
 *
 * No LLM provider is ever used: the tag-duplicate pass runs auditTags with a null
 * provider, so it stays edit-distance only and answers instantly (invariants R4).
 */

export interface InsightDoc {
  key: string;
  title: string;
  /** Document path; absent where the source query does not carry one (broken-link sources) */
  path?: string;
}

export interface InsightGroup {
  /** Total findings; `docs` is capped at LIST_LIMIT */
  count: number;
  docs: InsightDoc[];
}

export interface BrokenLinkInsight {
  targetTitle: string;
  sources: InsightDoc[];
}

export interface KuraInsights {
  /** Documents with no resolved link in either direction */
  orphans: InsightGroup;
  untagged: InsightGroup;
  /** Documents still at the bucket root — the filing backlog */
  unfiled: InsightGroup;
  brokenLinks: { count: number; links: BrokenLinkInsight[] };
  /** Tag pairs close enough to be the same tag spelled twice */
  tagDuplicates: TagMergeCandidate[];
}

const LIST_LIMIT = 50;

interface DocRow {
  key: string;
  path: string;
  title: string;
}

const ORPHAN_SQL = `
  SELECT d.doc_key AS key, d.path, d.title
  FROM documents d JOIN buckets b ON b.id = d.bucket_id
  WHERE b.name = ?
    AND NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id = d.id AND l.target_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM links l WHERE l.target_id = d.id)
  ORDER BY d.updated_at DESC`;

function group(docs: DocRow[]): InsightGroup {
  return { count: docs.length, docs: docs.slice(0, LIST_LIMIT) };
}

export async function collectInsights(
  db: Database,
  config: KuraConfig,
  bucketName: string,
): Promise<KuraInsights> {
  const bucket = requireBucket(db, bucketName);

  const orphans = db.prepare(ORPHAN_SQL).all(bucketName) as DocRow[];

  // untaggedDocuments / listUnfiledDocuments carry more than the UI needs; project them down
  const untagged = untaggedDocuments(db, bucketName).map((d) => ({
    key: d.key,
    path: d.path,
    title: d.title,
  }));
  const unfiled = listUnfiledDocuments(db, bucketName).map((d) => ({
    key: d.key,
    path: d.path,
    title: d.title,
  }));

  const broken = brokenLinks(db, bucket.id);
  const audit = await auditTags(db, null, config, { bucket: bucketName });

  return {
    orphans: group(orphans),
    untagged: group(untagged),
    unfiled: group(unfiled),
    brokenLinks: {
      count: broken.length,
      links: broken.slice(0, LIST_LIMIT).map((l) => ({
        targetTitle: l.targetTitle,
        sources: l.sources.map((s) => ({ key: s.key, title: s.title })),
      })),
    },
    tagDuplicates: audit.merges,
  };
}
