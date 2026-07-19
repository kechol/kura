import type { Database } from "bun:sqlite";
import { addAliasesToDoc } from "./aliases";
import { similarChunkPairs } from "./audit";
import type { KuraConfig } from "./config";
import { type DocumentRecord, deleteDocument, getDocumentById } from "./documents";
import { cached, pairKey } from "./llm/cache";
import { parseJsonObject } from "./llm/parse";
import type { LLMProvider } from "./llm/provider";
import {
  distanceToSimilarity,
  ensureEmbeddings,
  prepareChunkKnn,
  similarityToDistance,
} from "./search/vector";
import { addTagsToDoc } from "./tags";

/**
 * Duplicate-detection and merge engine (docs: self-healing.md). Consumed by
 * the per-document `kura triage` pipeline (exact + near for one document) and
 * by the store-wide `kura audit dupes` pass. Exact detection needs no provider;
 * near-duplicate detection is LLM-required (embeddings + a verdict) and cached
 * under purpose "dupe", degrading to exact-only when no provider is reachable
 * (invariants R4).
 */

/**
 * Similarity floor (1 / (1 + L2 distance), the vector-search scale) below which
 * a near-duplicate candidate is dropped before the LLM ever sees it. With
 * L2-normalized embeddings 0.6 corresponds to distance ≈ 0.67 (cosine ≈ 0.78) —
 * a deliberately conservative net that admits genuine near-duplicates while
 * excluding merely-related documents. The LLM verdict on the closest few is the
 * real filter; this constant only bounds how wide the net is cast.
 */
export const NEAR_DUP_MIN_SIMILARITY = 0.6;

/**
 * The similarity floor expressed as an L2 distance ceiling, for the store-wide
 * scan's KNN filter (similarChunkPairs filters on raw distance, not similarity).
 */
const NEAR_DUP_MAX_DISTANCE = similarityToDistance(NEAR_DUP_MIN_SIMILARITY);

/** KNN neighbours fetched per chunk for the one-document-vs-store scan */
const KNN_PER_CHUNK = 10;

/** Closest candidates handed to the LLM verdict (the real filter is per-pair) */
const MAX_JUDGE_CANDIDATES = 3;

/** Characters of each document shown to the verdict model */
const JUDGE_CHARS = 1200;

export interface DupeCandidate {
  doc: DocumentRecord;
  /** Similarity on the vector-search scale (distanceToSimilarity) */
  similarity: number;
  /** True when this candidate shares the target's content hash (byte-identical) */
  exact: boolean;
  /** LLM verdict; absent when unjudged (only the closest few are judged) */
  verdict?: { duplicate: boolean; keep: "current" | "other"; reason?: string };
}

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const DUPE_PROMPT = `あなたはナレッジベースの重複を点検するアシスタントです。
2 つの文書 A・B を比較し、実質的に同じ内容の重複かどうかを判定してください。
重複の場合は、より完全で新しい方（情報量が多い、または新しく更新された方）を残すべきものとして選んでください。
- 話題が近いだけ、一部が重なるだけの文書は重複ではありません。
- 内容の大部分が一致し、一方が他方をほぼ包含する場合のみ重複と判定してください。
出力は JSON のみ: {"duplicate": true または false, "keep": "a" または "b", "reason": "一行の理由"}`;

/** Cached verdict shape: keep is stored as the surviving document's content hash */
interface DupeVerdict {
  duplicate: boolean;
  keepHash: string;
  reason: string;
}

/**
 * Documents (any bucket) byte-identical to `doc`, excluding itself. Reads the
 * ids by content hash, then reuses the exported getDocumentById so no repository
 * internal (toRecord / SELECT_DOC) has to leak — exact duplicates are rare, so
 * the per-row fetch cost is negligible.
 */
export function exactDuplicates(db: Database, doc: DocumentRecord): DocumentRecord[] {
  const rows = db
    .prepare("SELECT id FROM documents WHERE content_hash = ? AND id != ? ORDER BY id")
    .all(doc.contentHash, doc.id) as Array<{ id: number }>;
  return rows.map((r) => getDocumentById(db, r.id));
}

/**
 * Ask the model whether two documents are the same content and which to keep.
 * Shared by the per-document `nearDuplicates` scan and the store-wide
 * `kura audit dupes` pass. `keep` is reported from the perspective of `a`
 * ("current" = a survives, "other" = b survives), and the verdict is cached
 * under a symmetric content-hash key so a hit from either document's viewpoint
 * resolves the surviving side correctly.
 */
export async function judgeDuplicatePair(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  a: DocumentRecord,
  b: DocumentRecord,
): Promise<DupeCandidate["verdict"] | undefined> {
  const model = config.llm.models.generation;
  const aText = `${a.title}\n${a.content.slice(0, JUDGE_CHARS)}`;
  const bText = `${b.title}\n${b.content.slice(0, JUDGE_CHARS)}`;
  // Unordered pair key. The verdict is stored as a content hash rather than
  // "a"/"b" so a cache hit from the other document's viewpoint still resolves the
  // surviving side correctly under this symmetric key.
  const cacheInput = pairKey(a.contentHash, b.contentHash);
  const verdict = await cached<DupeVerdict>(db, "dupe", model, cacheInput, async () => {
    const answer = await provider.chat(
      [
        { role: "system", content: DUPE_PROMPT },
        { role: "user", content: `文書A:\n${aText}\n\n文書B:\n${bText}` },
      ],
      model,
      { temperature: 0 },
    );
    let duplicate = false;
    let keep: "a" | "b" = "a";
    let reason = "";
    // Unparseable answer → the conservative "not a duplicate" default stands.
    const p = parseJsonObject<{ duplicate?: unknown; keep?: unknown; reason?: unknown }>(answer);
    if (p) {
      duplicate = p.duplicate === true;
      keep = p.keep === "b" ? "b" : "a";
      reason = typeof p.reason === "string" ? p.reason : "";
    }
    return { duplicate, keepHash: keep === "a" ? a.contentHash : b.contentHash, reason };
  });
  return {
    duplicate: verdict.duplicate,
    keep: verdict.keepHash === a.contentHash ? "current" : "other",
    reason: verdict.reason === "" ? undefined : verdict.reason,
  };
}

/**
 * Near-duplicate candidates for one document, ranked by similarity. Requires a
 * provider for embeddings; with none it returns no candidates and a warning
 * (the caller still runs the provider-free exactDuplicates check).
 *
 * similarChunkPairs (src/core/audit.ts) cannot serve this: it pairs chunks only
 * within its recent-documents set, never one arbitrary document against the whole
 * store. This walks the target's chunk embeddings directly, running a per-chunk
 * KNN over chunks_vec (prepareChunkKnn) and mapping each neighbour chunk back to
 * its document, keeping the smallest distance per other document.
 */
export async function nearDuplicates(
  db: Database,
  provider: LLMProvider | null,
  config: KuraConfig,
  doc: DocumentRecord,
): Promise<{ candidates: DupeCandidate[]; warnings: string[] }> {
  if (!provider) {
    return {
      candidates: [],
      warnings: [
        "no LLM provider available; near-duplicate detection skipped (exact-hash check still runs)",
      ],
    };
  }

  const warnings: string[] = [];
  const warn = await ensureEmbeddings(db, provider, config);
  if (warn) warnings.push(warn);

  const chunkRows = db
    .prepare(
      `SELECT v.embedding FROM chunks c JOIN chunks_vec v ON v.chunk_id = c.id
       WHERE c.document_id = ?`,
    )
    .all(doc.id) as Array<{ embedding: Uint8Array }>;
  if (chunkRows.length === 0) return { candidates: [], warnings };

  const knnStmt = prepareChunkKnn(db);
  const docByChunk = db.prepare("SELECT document_id FROM chunks WHERE id = ?");
  const bestByDoc = new Map<number, number>();
  for (const { embedding } of chunkRows) {
    const neighbours = knnStmt.all(embedding, KNN_PER_CHUNK) as Array<{
      chunk_id: number;
      distance: number;
    }>;
    // Map each neighbour chunk back to its document, dropping the target's own chunks.
    for (const n of neighbours) {
      const owner = docByChunk.get(n.chunk_id) as { document_id: number } | null;
      if (!owner || owner.document_id === doc.id) continue;
      const prev = bestByDoc.get(owner.document_id);
      if (prev === undefined || n.distance < prev) bestByDoc.set(owner.document_id, n.distance);
    }
  }

  const candidates: DupeCandidate[] = [];
  for (const [docId, distance] of bestByDoc) {
    const similarity = distanceToSimilarity(distance);
    if (similarity < NEAR_DUP_MIN_SIMILARITY) continue;
    const record = getDocumentById(db, docId);
    // Byte-identical documents are exact duplicates, reported separately.
    if (record.contentHash === doc.contentHash) continue;
    candidates.push({ doc: record, similarity, exact: false });
  }
  candidates.sort((a, b) => b.similarity - a.similarity);

  await Promise.all(
    candidates.slice(0, MAX_JUDGE_CANDIDATES).map(async (c) => {
      try {
        c.verdict = await judgeDuplicatePair(db, provider, config, doc, c.doc);
      } catch (e) {
        warnings.push(
          `duplicate verdict failed for #${c.doc.key} (${e instanceof Error ? e.message : e})`,
        );
      }
    }),
  );

  return { candidates, warnings };
}

/**
 * Merge a duplicate into a survivor: the duplicate's title and aliases become
 * aliases of the survivor, its tags ride along, then the duplicate is deleted.
 * Alias self-healing re-resolves any `[[old title]]` links onto the survivor
 * (docs: document-notation.md), and carrying the tags means a merge never loses
 * organization. Repository functions do every write (invariants R1), wrapped in
 * one transaction so the merge is atomic (invariants R2).
 */
export function mergeDuplicate(
  db: Database,
  survivorId: number,
  duplicateId: number,
): { aliasesAdded: string[]; tagsAdded: string[] } {
  return db.transaction(() => {
    const dup = getDocumentById(db, duplicateId);
    const tagsAdded = addTagsToDoc(db, survivorId, dup.tags, "auto");
    // Delete the duplicate *before* adding its title/aliases to the survivor.
    // deleteDocument sets every incoming [[duplicate title]] link's target to
    // NULL, and addAliasesToDoc's self-healing then re-resolves those now-
    // unresolved links onto the survivor. Adding the aliases first would leave
    // the links resolved to the about-to-be-deleted document (they never become
    // NULL in time to be re-resolved), so the order here is load-bearing.
    deleteDocument(db, duplicateId);
    const aliasesAdded = addAliasesToDoc(db, survivorId, [dup.title, ...dup.aliases]);
    return { aliasesAdded, tagsAdded };
  })();
}

// ---------------------------------------------------------------------------
// Store-wide duplicate audit (kura audit dupes). Pure data-returning core; the
// CLI owns rendering and the interactive merge loop (invariants R9).
// ---------------------------------------------------------------------------

export interface DupeDocRef {
  id: number;
  key: string;
  title: string;
  path: string;
  bucket: string;
}

export interface NearDupeFinding {
  /** "current" side of the verdict (survives on keep === "current") */
  a: DupeDocRef;
  b: DupeDocRef;
  similarity: number;
  /** Absent when no provider judged the pair (reported as an unjudged close pair) */
  verdict?: NonNullable<DupeCandidate["verdict"]>;
}

export interface DupesResult {
  /** Byte-identical groups (survivor-first, most recently updated first) */
  exact: DupeDocRef[][];
  near: NearDupeFinding[];
  warnings: string[];
}

function toRef(rec: DocumentRecord): DupeDocRef {
  return { id: rec.id, key: rec.key, title: rec.title, path: rec.path, bucket: rec.bucket };
}

/**
 * Content-hash duplicate groups (no LLM). Reads are allowed to query directly
 * (invariants R1); the outer query keeps only rows whose hash appears more than
 * once within the same scope, ordered so the survivor (most recently updated) is
 * first in each group.
 */
export function exactGroups(db: Database, bucket?: string): DupeDocRef[][] {
  const outerBucket = bucket ? "b.name = ? AND " : "";
  const innerFrom = bucket
    ? "documents d2 JOIN buckets b2 ON b2.id = d2.bucket_id WHERE b2.name = ?"
    : "documents";
  const params = bucket ? [bucket, bucket] : [];
  const rows = db
    .prepare(
      `SELECT d.id, d.doc_key AS key, d.title, d.path, b.name AS bucket, d.content_hash AS hash
       FROM documents d JOIN buckets b ON b.id = d.bucket_id
       WHERE ${outerBucket}d.content_hash IN (
         SELECT content_hash FROM ${innerFrom}
         GROUP BY content_hash HAVING COUNT(*) > 1
       )
       ORDER BY d.content_hash, d.updated_at DESC`,
    )
    .all(...params) as Array<DupeDocRef & { hash: string }>;

  const groups = new Map<string, DupeDocRef[]>();
  for (const r of rows) {
    let group = groups.get(r.hash);
    if (!group) {
      group = [];
      groups.set(r.hash, group);
    }
    group.push({ id: r.id, key: r.key, title: r.title, path: r.path, bucket: r.bucket });
  }
  return [...groups.values()];
}

/**
 * Store-wide duplicate detection. Exact detection needs no provider; the near
 * pass reuses the shared chunk-pair KNN (similarChunkPairs, src/core/audit.ts)
 * capped at the similarity floor and asks the generation model for a verdict
 * (judgeDuplicatePair). With no provider it degrades to reporting close pairs
 * without verdicts (invariants R4) rather than failing.
 */
export async function auditDupes(
  db: Database,
  provider: LLMProvider | null,
  config: KuraConfig,
  opts: { bucket?: string; limit?: number },
): Promise<DupesResult> {
  const warnings: string[] = [];
  const exact = exactGroups(db, opts.bucket);

  if (provider) {
    const warn = await ensureEmbeddings(db, provider, config);
    if (warn) warnings.push(warn);
  } else {
    warnings.push("no LLM provider available; showing close pairs without duplicate verdicts");
  }

  const candidates = similarChunkPairs(db, {
    bucket: opts.bucket,
    limit: opts.limit,
    maxDistance: NEAR_DUP_MAX_DISTANCE,
  });

  const near: NearDupeFinding[] = [];
  for (const c of candidates) {
    const a = getDocumentById(db, c.aDoc);
    const b = getDocumentById(db, c.bDoc);
    // Byte-identical pairs already belong to the exact pass.
    if (a.contentHash === b.contentHash) continue;
    const similarity = distanceToSimilarity(c.distance);
    if (!provider) {
      near.push({ a: toRef(a), b: toRef(b), similarity });
      continue;
    }
    let verdict: DupeCandidate["verdict"] | undefined;
    try {
      verdict = await judgeDuplicatePair(db, provider, config, a, b);
    } catch (e) {
      warnings.push(
        `duplicate verdict failed for #${a.key}/#${b.key} (${e instanceof Error ? e.message : e})`,
      );
      continue;
    }
    if (!verdict?.duplicate) continue;
    near.push({ a: toRef(a), b: toRef(b), similarity, verdict });
  }
  return { exact, near, warnings };
}
