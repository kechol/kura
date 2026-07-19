import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import { sha256Hex } from "./documents";
import { cached } from "./llm/cache";
import type { LLMProvider } from "./llm/provider";
import { parseYesNo } from "./search/rerank";
import { chunkSnippet, ensureEmbeddings } from "./search/vector";
import { joinDocPath } from "./wiki";

/**
 * Contradiction audit (kura audit, docs: search-pipeline.md): find pairs of
 * semantically close chunks from different documents and ask the generation
 * model whether their statements contradict each other. Candidate pairs come
 * from chunks_vec KNN over the most recently updated documents; verdicts are
 * cached in llm_cache (purpose "audit") keyed on the unordered pair of chunk
 * text hashes, so re-runs are free until either side changes. LLM-required:
 * callers gate on requireProvider (exit 4 when absent).
 */

/** Documents examined per run (most recently updated first) */
const MAX_AUDIT_DOCS = 50;

/** KNN neighbours fetched per chunk when generating candidate pairs */
const KNN_PER_CHUNK = 6;

/** Characters of each excerpt shown to the judge */
const MAX_JUDGE_CHARS = 1200;

/** Parallel judge calls (same shape as the rerank worker pool) */
const CONCURRENCY = 4;

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const PROMPT = `あなたはナレッジベースの品質を点検するアシスタントです。
2 つの資料の記述を比較し、事実や結論が互いに矛盾しているかを判定してください。

- 単なる話題の重複、詳しさの違い、観点の違いは矛盾ではありません。
- 一方が「する」と述べ、他方が「してはいけない」と述べるような、両立しない記述だけを矛盾と判定してください。
- 回答は「yes」（矛盾している）または「no」（矛盾していない）のみ。説明は不要です。`;

export interface AuditDocRef {
  key: string;
  title: string;
  path: string;
  bucket: string;
  /** The chunk text that participated in the pair (display-trimmed) */
  excerpt: string;
}

export interface ContradictionPair {
  a: AuditDocRef;
  b: AuditDocRef;
  /** 1 / (1 + L2 distance), same scale as vector search scores */
  similarity: number;
  contradictory: boolean;
}

export interface AuditOptions {
  bucket?: string;
  /** Maximum candidate pairs judged (default 10) */
  limit?: number;
}

export interface AuditOutcome {
  pairs: ContradictionPair[];
  examinedPairs: number;
  warnings: string[];
}

interface ChunkRow {
  chunk_id: number;
  doc_id: number;
  text: string;
}

interface CandidatePair {
  aDoc: number;
  bDoc: number;
  aText: string;
  bText: string;
  distance: number;
}

/**
 * Semantically closest cross-document chunk pairs among recent documents.
 * The recent-doc set is resolved first so the chunk query is a plain IN list
 * (no duplicated bucket predicates), and each chunk's stored embedding rides
 * along via the chunks_vec join instead of a per-chunk lookup.
 */
function candidatePairs(db: Database, opts: AuditOptions, maxPairs: number): CandidatePair[] {
  const docParams: string[] = [];
  let docWhere = "";
  if (opts.bucket) {
    docWhere = "WHERE b.name = ?";
    docParams.push(opts.bucket);
  }
  const docIds = (
    db
      .prepare(
        `SELECT d.id FROM documents d JOIN buckets b ON b.id = d.bucket_id
         ${docWhere} ORDER BY d.updated_at DESC LIMIT ${MAX_AUDIT_DOCS}`,
      )
      .all(...docParams) as Array<{ id: number }>
  ).map((r) => r.id);
  if (docIds.length === 0) return [];

  const chunks = db
    .prepare(
      `SELECT c.id AS chunk_id, c.document_id AS doc_id, c.text, v.embedding
       FROM chunks c JOIN chunks_vec v ON v.chunk_id = c.id
       WHERE c.document_id IN (${docIds.map(() => "?").join(", ")})`,
    )
    .all(...docIds) as Array<ChunkRow & { embedding: Uint8Array }>;

  const textByChunk = new Map(chunks.map((c) => [c.chunk_id, c] as const));
  const knnStmt = db.prepare(
    `SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?`,
  );

  const best = new Map<string, CandidatePair>();
  for (const chunk of chunks) {
    const neighbours = knnStmt.all(chunk.embedding, KNN_PER_CHUNK) as Array<{
      chunk_id: number;
      distance: number;
    }>;
    for (const n of neighbours) {
      const other = textByChunk.get(n.chunk_id);
      if (!other || other.doc_id === chunk.doc_id) continue;
      const key =
        chunk.doc_id < other.doc_id
          ? `${chunk.doc_id}:${other.doc_id}`
          : `${other.doc_id}:${chunk.doc_id}`;
      const existing = best.get(key);
      if (existing && existing.distance <= n.distance) continue;
      best.set(key, {
        aDoc: chunk.doc_id,
        bDoc: other.doc_id,
        aText: chunk.text,
        bText: other.text,
        distance: n.distance,
      });
    }
  }
  return [...best.values()].sort((x, y) => x.distance - y.distance).slice(0, maxPairs);
}

/**
 * Judge candidate pairs with the generation model (worker pool, like rerank).
 * Requires a provider; embeddings are freshened first so callers cannot
 * silently audit a stale index (warning surfaced when the backlog is large).
 */
export async function findContradictions(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  opts: AuditOptions = {},
): Promise<AuditOutcome> {
  const warnings: string[] = [];
  const warn = await ensureEmbeddings(db, provider, config);
  if (warn) warnings.push(warn);

  const candidates = candidatePairs(db, opts, opts.limit ?? 10);
  const model = config.llm.models.generation;
  const refStmt = db.prepare(
    `SELECT d.doc_key, d.title, d.path, b.name AS bucket
     FROM documents d JOIN buckets b ON b.id = d.bucket_id WHERE d.id = ?`,
  );
  const docRef = (docId: number, excerpt: string): AuditDocRef => {
    const row = refStmt.get(docId) as {
      doc_key: string;
      title: string;
      path: string;
      bucket: string;
    };
    return {
      key: row.doc_key,
      title: row.title,
      path: row.path,
      bucket: row.bucket,
      excerpt: chunkSnippet(excerpt, 200),
    };
  };

  const pairs = new Array<ContradictionPair>(candidates.length);
  let index = 0;
  async function worker(): Promise<void> {
    while (index < candidates.length) {
      const i = index++;
      const c = candidates[i]!;
      const aText = c.aText.slice(0, MAX_JUDGE_CHARS);
      const bText = c.bText.slice(0, MAX_JUDGE_CHARS);
      const cacheInput = [sha256Hex(aText), sha256Hex(bText)].sort().join(":");
      const score = await cached<number>(db, "audit", model, cacheInput, async () => {
        const answer = await provider.chat(
          [
            { role: "system", content: PROMPT },
            { role: "user", content: `資料A:\n${aText}\n\n資料B:\n${bText}` },
          ],
          model,
          { temperature: 0 },
        );
        return parseYesNo(answer);
      });
      pairs[i] = {
        a: docRef(c.aDoc, c.aText),
        b: docRef(c.bDoc, c.bText),
        similarity: 1 / (1 + c.distance),
        contradictory: score === 1,
      };
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()),
  );
  return { pairs, examinedPairs: candidates.length, warnings };
}

/** Human-readable pair label for CLI output */
export function pairLabel(pair: ContradictionPair): string {
  const side = (r: AuditDocRef) => `#${r.key} ${joinDocPath(r.path, r.title)}`;
  return `${side(pair.a)} <-> ${side(pair.b)}`;
}
