import type { Database } from "bun:sqlite";
import { requireBucket } from "./buckets";
import { UNFILED_WHERE, UNTAGGED_WHERE } from "./documents";
import { type TagMergeCandidate, tagMergeCandidates } from "./gardening";
import { brokenLinks } from "./links";
import { listTags } from "./tags";

/**
 * Read-only tidying insights for one bucket (docs: self-healing.md). Nothing is repaired
 * automatically — the browser lists the findings and points at the CLI command that fixes
 * them — and nothing here needs an LLM: the duplicate-tag pass is the synchronous
 * edit-distance half of the gardening audit (invariants R4).
 *
 * The queries project down to key/path/title on purpose: this endpoint only lists titles,
 * and a statistics page must not read the whole bucket to draw a count. The unfiled /
 * untagged groups reuse the canonical UNFILED_WHERE / UNTAGGED_WHERE predicates
 * (src/core/documents.ts).
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

const NO_RESOLVED_LINK = `
  NOT EXISTS (SELECT 1 FROM links l WHERE l.source_id = d.id AND l.target_id IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM links l WHERE l.target_id = d.id)`;

function group(db: Database, bucket: string, where: string): InsightGroup {
  const docs = db
    .prepare(
      `SELECT d.doc_key AS key, d.path, d.title
       FROM documents d JOIN buckets b ON b.id = d.bucket_id
       WHERE b.name = ? AND (${where})
       ORDER BY d.updated_at DESC`,
    )
    .all(bucket) as InsightDoc[];
  return { count: docs.length, docs: docs.slice(0, LIST_LIMIT) };
}

export function collectInsights(db: Database, bucketName: string): KuraInsights {
  const bucket = requireBucket(db, bucketName);
  const broken = brokenLinks(db, bucket.id);

  return {
    orphans: group(db, bucketName, NO_RESOLVED_LINK),
    untagged: group(db, bucketName, UNTAGGED_WHERE),
    unfiled: group(db, bucketName, UNFILED_WHERE),
    brokenLinks: {
      count: broken.length,
      links: broken.slice(0, LIST_LIMIT).map((l) => ({
        targetTitle: l.targetTitle,
        sources: l.sources.map((s) => ({ key: s.key, title: s.title })),
      })),
    },
    // Tags are global, but only the ones this bucket uses are worth proposing merges for
    tagDuplicates: tagMergeCandidates(listTags(db, { bucket: bucketName })),
  };
}
