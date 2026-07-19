import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import type { FtsTokenizer } from "./db";
import { type DocumentRecord, sha256Hex } from "./documents";
import { cached } from "./llm/cache";
import { parseJsonObject } from "./llm/parse";
import type { LLMProvider } from "./llm/provider";
import { keywordSearch } from "./search/keyword";
import { vectorSearch } from "./search/vector";
import { normalizeDocPath } from "./wiki";

/**
 * Filing assistant for kura mv suggest (docs: cli-reference.md).
 *
 * Suggests a document path for unfiled (bucket-root) documents from three
 * signal layers, mirroring the search pipeline's degradation ladder:
 *   1. structural — links/backlinks, shared tags, BM25 title neighbors
 *      (always available, no provider needed)
 *   2. semantic — vector-search neighbors (embedding provider)
 *   3. LLM — final pick with a one-line reason, or a new-path proposal
 *      (generation provider; Japanese prompt, cached under purpose 'path')
 */

export interface PathCandidate {
  path: string;
  score: number;
  /** Human-readable signals behind the score, e.g. "link: [[タイトル]]" */
  evidence: string[];
}

export interface LlmPick {
  path: string;
  reason: string;
  /** True when the path is not among the scored candidates */
  isNew: boolean;
}

export interface PathSuggestion {
  doc: DocumentRecord;
  /** Scored candidates, best first (empty when the document has no signals) */
  candidates: PathCandidate[];
  /** LLM refinement; null without a provider or when the answer was unusable */
  llm: LlmPick | null;
  /** Non-fatal signal-layer failures (e.g. vector search unavailable) */
  warnings: string[];
}

interface Vote {
  path: string;
  weight: number;
  evidence: string;
}

function collectStructuralVotes(db: Database, doc: DocumentRecord): Vote[] {
  const votes: Vote[] = [];

  // Resolved links in both directions are the strongest locality signal
  const linked = db
    .prepare(
      `SELECT d2.path AS path, d2.title AS title
       FROM links l JOIN documents d2 ON d2.id = l.target_id
       WHERE l.source_id = ? AND d2.path != ''
       UNION ALL
       SELECT d2.path AS path, d2.title AS title
       FROM links l JOIN documents d2 ON d2.id = l.source_id
       WHERE l.target_id = ? AND d2.path != ''`,
    )
    .all(doc.id, doc.id) as Array<{ path: string; title: string }>;
  for (const row of linked) {
    votes.push({ path: row.path, weight: 3, evidence: `link: [[${row.title}]]` });
  }

  // Shared tags, weighted by how many tags overlap (capped)
  const tagged = db
    .prepare(
      `SELECT d2.path AS path, d2.title AS title, COUNT(*) AS shared
       FROM document_tags dt1
       JOIN document_tags dt2 ON dt2.tag_id = dt1.tag_id AND dt2.document_id != dt1.document_id
       JOIN documents d2 ON d2.id = dt2.document_id
       WHERE dt1.document_id = ? AND d2.bucket_id = ? AND d2.path != ''
       GROUP BY dt2.document_id`,
    )
    .all(doc.id, doc.bucketId) as Array<{ path: string; title: string; shared: number }>;
  for (const row of tagged) {
    votes.push({
      path: row.path,
      weight: Math.min(row.shared, 3),
      evidence: `shared tags (${row.shared}): ${row.title}`,
    });
  }
  return votes;
}

function collectKeywordVotes(db: Database, tokenizer: FtsTokenizer, doc: DocumentRecord): Vote[] {
  const hits = keywordSearch(db, tokenizer, doc.title, { bucket: doc.bucket, limit: 8 });
  return hits
    .filter((h) => h.key !== doc.key && h.path !== "")
    .map((h) => ({ path: h.path, weight: 1, evidence: `keyword: ${h.title}` }));
}

async function collectVectorVotes(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  doc: DocumentRecord,
): Promise<Vote[]> {
  const query = `${doc.title}\n${doc.content.slice(0, 1000)}`;
  const hits = await vectorSearch(db, provider, config, query, {
    bucket: doc.bucket,
    limit: 8,
  });
  return hits
    .filter((h) => h.key !== doc.key && h.path !== "")
    .map((h) => ({ path: h.path, weight: 2, evidence: `semantic: ${h.title}` }));
}

function aggregateVotes(votes: Vote[], limit = 3): PathCandidate[] {
  const byPath = new Map<string, PathCandidate>();
  for (const vote of votes) {
    let candidate = byPath.get(vote.path);
    if (!candidate) {
      candidate = { path: vote.path, score: 0, evidence: [] };
      byPath.set(vote.path, candidate);
    }
    candidate.score += vote.weight;
    if (!candidate.evidence.includes(vote.evidence)) candidate.evidence.push(vote.evidence);
  }
  return [...byPath.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const PATH_PROMPT = `あなたはナレッジベースの整理アシスタントです。
ドキュメントを保存すべき path（フォルダに相当するスラッシュ区切りの名前空間）を 1 つ選んでください。
候補 path とその根拠を最優先で検討し、どうしても合わない場合のみ既存 path 一覧から選ぶか、新しい path を提案してください。
出力は JSON のみ: {"path": "選んだ path", "reason": "一行の理由"}`;

async function llmPick(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  doc: DocumentRecord,
  candidates: PathCandidate[],
  existingPaths: string[],
): Promise<LlmPick | null> {
  const model = config.llm.models.generation;
  const excerpt = `${doc.title}\n\n${doc.content.slice(0, 2000)}`;
  const candidateText =
    candidates.length > 0
      ? candidates.map((c) => `- ${c.path} (score ${c.score}: ${c.evidence.join(", ")})`).join("\n")
      : "(なし)";
  const input = `${sha256Hex(excerpt)}\x00${candidateText}\x00${existingPaths.join(",")}`;
  const answer = await cached<string>(db, "path", model, input, () =>
    provider.chat(
      [
        { role: "system", content: PATH_PROMPT },
        {
          role: "user",
          content: `候補 path:\n${candidateText}\n\n既存 path 一覧: ${existingPaths.join(", ") || "(なし)"}\n\nドキュメント:\n${excerpt}`,
        },
      ],
      model,
      { temperature: 0 },
    ),
  );
  const parsed = parseJsonObject<{ path?: unknown; reason?: unknown }>(answer);
  if (!parsed) return null;
  const path = typeof parsed.path === "string" ? normalizeDocPath(parsed.path) : "";
  if (path === "") return null;
  return {
    path,
    reason: typeof parsed.reason === "string" ? parsed.reason : "",
    isNew: !candidates.some((c) => c.path.toLowerCase() === path.toLowerCase()),
  };
}

/** All non-root paths of a bucket, most-populated first (LLM context) */
function existingPaths(db: Database, bucketId: number, limit = 100): string[] {
  const rows = db
    .prepare(
      `SELECT path, COUNT(*) AS n FROM documents
       WHERE bucket_id = ? AND path != ''
       GROUP BY path ORDER BY n DESC, path LIMIT ?`,
    )
    .all(bucketId, limit) as Array<{ path: string }>;
  return rows.map((r) => r.path);
}

/**
 * Suggest a path for one unfiled document. Works with provider = null
 * (structural signals only — degraded operation, invariants R4); the vector
 * and LLM layers fail soft into warnings.
 */
export async function suggestPathForDocument(
  db: Database,
  tokenizer: FtsTokenizer,
  config: KuraConfig,
  provider: LLMProvider | null,
  doc: DocumentRecord,
): Promise<PathSuggestion> {
  const warnings: string[] = [];
  const votes = collectStructuralVotes(db, doc);
  try {
    votes.push(...collectKeywordVotes(db, tokenizer, doc));
  } catch (e) {
    warnings.push(`keyword signals unavailable (${e instanceof Error ? e.message : e})`);
  }
  if (provider) {
    try {
      votes.push(...(await collectVectorVotes(db, provider, config, doc)));
    } catch (e) {
      warnings.push(`vector signals unavailable (${e instanceof Error ? e.message : e})`);
    }
  }
  const candidates = aggregateVotes(votes);

  let llm: LlmPick | null = null;
  if (provider) {
    try {
      llm = await llmPick(db, provider, config, doc, candidates, existingPaths(db, doc.bucketId));
    } catch (e) {
      warnings.push(`LLM suggestion failed (${e instanceof Error ? e.message : e})`);
    }
  }
  return { doc, candidates, llm, warnings };
}

/** The path a suggestion recommends applying (LLM pick first, then the top candidate) */
export function suggestedPath(s: PathSuggestion): string | null {
  return s.llm?.path ?? s.candidates[0]?.path ?? null;
}
