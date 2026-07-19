import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import type { LLMProvider } from "./llm/provider";
import { listTags, type TagEntry } from "./tags";

export interface TagMergeCandidate {
  /** Merge source (the less-used or longer tag) */
  from: string;
  /** Merge destination */
  to: string;
  reason: string;
  similarity: number;
}

export interface OversizedTag {
  path: string;
  count: number;
  /** Share of all documents carrying this tag (0-1) */
  share: number;
}

export interface TagAuditResult {
  merges: TagMergeCandidate[];
  oversized: OversizedTag[];
  /** Whether embedding similarity was available */
  usedEmbeddings: boolean;
}

/** Levenshtein distance (used to detect tag-name spelling variants) */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[n]!;
}

function normalizedDistance(a: string, b: string): number {
  return levenshtein(a, b) / Math.max(a.length, b.length);
}

function isAncestor(a: string, b: string): boolean {
  return b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/** Simple singular/plural variants (for English tags) */
function isPluralVariant(a: string, b: string): boolean {
  return a === `${b}s` || b === `${a}s` || a === `${b}es` || b === `${a}es`;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

const EDIT_DISTANCE_THRESHOLD = 0.25;
const EMBEDDING_SIMILARITY_THRESHOLD = 0.85;
const OVERSIZED_SHARE = 0.3;

const pairKey = (a: string, b: string): string => [a, b].sort().join("\x00");

/** Merge direction: into the more-used tag (into the shorter path on a tie) */
function direction(a: TagEntry, b: TagEntry): { from: string; to: string } {
  if (a.count !== b.count) {
    return a.count > b.count ? { from: b.path, to: a.path } : { from: a.path, to: b.path };
  }
  return a.path.length <= b.path.length
    ? { from: b.path, to: a.path }
    : { from: a.path, to: b.path };
}

/**
 * Spelling-variant merge candidates: normalized edit distance plus singular/plural.
 * Pure and synchronous — no database, no LLM — so the browser's statistics screen can ask
 * for it on every page view (docs: self-healing.md).
 */
export function tagMergeCandidates(tags: TagEntry[]): TagMergeCandidate[] {
  const merges: TagMergeCandidate[] = [];
  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i]!;
      const b = tags[j]!;
      if (isAncestor(a.path, b.path)) continue;
      const plural = isPluralVariant(a.path, b.path);
      // The edit distance is at least the length gap, so a wide gap can never pass the
      // threshold — skip the O(n·m) DP for the pairs that cannot qualify
      if (
        !plural &&
        Math.abs(a.path.length - b.path.length) / Math.max(a.path.length, b.path.length) >
          EDIT_DISTANCE_THRESHOLD
      ) {
        continue;
      }
      const dist = normalizedDistance(a.path, b.path);
      if (dist <= EDIT_DISTANCE_THRESHOLD || plural) {
        merges.push({
          ...direction(a, b),
          reason: plural ? "singular/plural variant" : `close edit distance (${dist.toFixed(2)})`,
          similarity: 1 - dist,
        });
      }
    }
  }
  return merges;
}

/**
 * Tag gardening audit (docs: self-healing.md): the merge candidates above plus, when a
 * provider is available, cosine similarity of tag-name embeddings, and tags attached to more
 * than 30% of all documents flagged as candidates for splitting.
 */
export async function auditTags(
  db: Database,
  provider: LLMProvider | null,
  config: KuraConfig,
): Promise<TagAuditResult> {
  const tags = listTags(db);
  const totalDocs = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;

  const merges = new Map<string, TagMergeCandidate>(
    tagMergeCandidates(tags).map((m) => [pairKey(m.from, m.to), m]),
  );

  // Embedding similarity (semantic duplicates, e.g. "db" and "database")
  let usedEmbeddings = false;
  if (provider && tags.length >= 2) {
    try {
      const vectors = await provider.embed(
        tags.map((t) => t.path),
        config.llm.models.embedding,
        config.llm.models.embedding_dimensions,
      );
      usedEmbeddings = true;
      for (let i = 0; i < tags.length; i++) {
        for (let j = i + 1; j < tags.length; j++) {
          const a = tags[i]!;
          const b = tags[j]!;
          if (isAncestor(a.path, b.path)) continue;
          const key = pairKey(a.path, b.path);
          if (merges.has(key)) continue;
          const sim = cosine(vectors[i]!, vectors[j]!);
          if (sim > EMBEDDING_SIMILARITY_THRESHOLD) {
            merges.set(key, {
              ...direction(a, b),
              reason: `high embedding similarity (${sim.toFixed(2)})`,
              similarity: sim,
            });
          }
        }
      }
    } catch {
      usedEmbeddings = false;
    }
  }

  const oversized: OversizedTag[] =
    totalDocs === 0
      ? []
      : tags
          .filter((t) => t.count / totalDocs > OVERSIZED_SHARE)
          .map((t) => ({ path: t.path, count: t.count, share: t.count / totalDocs }));

  return {
    merges: [...merges.values()].sort((a, b) => b.similarity - a.similarity),
    oversized,
    usedEmbeddings,
  };
}
