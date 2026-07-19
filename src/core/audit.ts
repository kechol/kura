import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import { sha256Hex } from "./documents";
import { cached } from "./llm/cache";
import type { LLMProvider } from "./llm/provider";
import { parseYesNo } from "./search/rerank";
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
export const MAX_AUDIT_DOCS = 50;

/** KNN neighbours fetched per chunk when generating candidate pairs */
const KNN_PER_CHUNK = 6;

/** Characters of each excerpt shown to the judge */
const MAX_JUDGE_CHARS = 1200;

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

function docRef(db: Database, docId: number, excerpt: string): AuditDocRef {
  const row = db
    .prepare(
      `SELECT d.doc_key, d.title, d.path, b.name AS bucket
       FROM documents d JOIN buckets b ON b.id = d.bucket_id WHERE d.id = ?`,
    )
    .get(docId) as { doc_key: string; title: string; path: string; bucket: string };
  const clean = excerpt.replaceAll(/\s+/g, " ").trim();
  return {
    key: row.doc_key,
    title: row.title,
    path: row.path,
    bucket: row.bucket,
    excerpt: clean.length > 200 ? `${clean.slice(0, 200)}…` : clean,
  };
}

/** Semantically closest cross-document chunk pairs among recent documents */
function candidatePairs(db: Database, opts: AuditOptions, maxPairs: number): CandidatePair[] {
  const params: Array<string | number> = [];
  let bucketWhere = "";
  if (opts.bucket) {
    bucketWhere = "AND b.name = ?";
    params.push(opts.bucket);
  }
  const chunks = db
    .prepare(
      `SELECT c.id AS chunk_id, c.document_id AS doc_id, c.text
       FROM chunks c
       JOIN documents d ON d.id = c.document_id
       JOIN buckets b ON b.id = d.bucket_id
       WHERE c.embedded_at IS NOT NULL ${bucketWhere}
         AND c.document_id IN (
           SELECT d2.id FROM documents d2 JOIN buckets b2 ON b2.id = d2.bucket_id
           WHERE 1=1 ${bucketWhere.replaceAll("b.name", "b2.name")}
           ORDER BY d2.updated_at DESC LIMIT ${MAX_AUDIT_DOCS})`,
    )
    .all(...params, ...params) as ChunkRow[];

  const textByChunk = new Map(chunks.map((c) => [c.chunk_id, c] as const));
  const embedStmt = db.prepare("SELECT embedding FROM chunks_vec WHERE chunk_id = ?");
  const knnStmt = db.prepare(
    `SELECT chunk_id, distance FROM chunks_vec WHERE embedding MATCH ? AND k = ?`,
  );

  const best = new Map<string, CandidatePair>();
  for (const chunk of chunks) {
    const embedding = embedStmt.get(chunk.chunk_id) as { embedding: Uint8Array } | null;
    if (!embedding) continue;
    const neighbours = knnStmt.all(embedding.embedding, KNN_PER_CHUNK) as Array<{
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

/** Judge candidate pairs with the generation model. Requires a provider */
export async function findContradictions(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  opts: AuditOptions = {},
): Promise<AuditOutcome> {
  const candidates = candidatePairs(db, opts, opts.limit ?? 10);
  const model = config.llm.models.generation;
  const pairs: ContradictionPair[] = [];

  for (const c of candidates) {
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
    pairs.push({
      a: docRef(db, c.aDoc, c.aText),
      b: docRef(db, c.bDoc, c.bText),
      similarity: 1 / (1 + c.distance),
      contradictory: score === 1,
    });
  }
  return { pairs, examinedPairs: candidates.length };
}

/** Human-readable pair label for CLI output */
export function pairLabel(pair: ContradictionPair): string {
  const side = (r: AuditDocRef) => `#${r.key} ${joinDocPath(r.path, r.title)}`;
  return `${side(pair.a)} <-> ${side(pair.b)}`;
}
