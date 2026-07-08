import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import type { LLMProvider } from "./llm/provider";
import { listTags } from "./tags";

export interface TagMergeCandidate {
  /** 統合元（少数派 or 長い方） */
  from: string;
  /** 統合先 */
  to: string;
  reason: string;
  similarity: number;
}

export interface OversizedTag {
  path: string;
  count: number;
  /** 全ドキュメントに対する付与率（0〜1） */
  share: number;
}

export interface TagAuditResult {
  merges: TagMergeCandidate[];
  oversized: OversizedTag[];
  /** embedding 類似度を使えたか */
  usedEmbeddings: boolean;
}

/** レーベンシュタイン距離（タグ名の表記ゆれ検出用） */
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

/** 単数/複数形の単純な表記ゆれ（英語タグ向け） */
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

/**
 * タグ・ガーデニング監査（SPEC §10.3）:
 * 正規化編集距離 + （プロバイダがあれば）タグ名 embedding の cos 類似度で統合候補を列挙し、
 * 全体の 30% 超に付くタグへ細分化を提案する。
 */
export async function auditTags(
  db: Database,
  provider: LLMProvider | null,
  config: KuraConfig,
): Promise<TagAuditResult> {
  const tags = listTags(db);
  const totalDocs = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;

  const merges = new Map<string, TagMergeCandidate>();
  const pairKey = (a: string, b: string): string => [a, b].sort().join("\x00");
  // 統合方向: 付与数が多い方へ（同数なら短い方へ）
  const direction = (
    a: (typeof tags)[number],
    b: (typeof tags)[number],
  ): { from: string; to: string } => {
    if (a.count !== b.count) {
      return a.count > b.count ? { from: b.path, to: a.path } : { from: a.path, to: b.path };
    }
    return a.path.length <= b.path.length
      ? { from: b.path, to: a.path }
      : { from: a.path, to: b.path };
  };

  for (let i = 0; i < tags.length; i++) {
    for (let j = i + 1; j < tags.length; j++) {
      const a = tags[i]!;
      const b = tags[j]!;
      if (isAncestor(a.path, b.path)) continue;
      const dist = normalizedDistance(a.path, b.path);
      const plural = isPluralVariant(a.path, b.path);
      if (dist <= EDIT_DISTANCE_THRESHOLD || plural) {
        merges.set(pairKey(a.path, b.path), {
          ...direction(a, b),
          reason: plural ? "単数/複数の表記ゆれ" : `編集距離が近い (${dist.toFixed(2)})`,
          similarity: 1 - dist,
        });
      }
    }
  }

  // embedding 類似（意味的な重複: 例 "db" と "database"）
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
              reason: `embedding 類似度が高い (${sim.toFixed(2)})`,
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

export interface UntaggedDoc {
  id: number;
  key: string;
  title: string;
  bucket: string;
  content: string;
}

/** タグなしドキュメントの列挙（tag suggest --untagged 用） */
export function untaggedDocuments(db: Database, bucket?: string): UntaggedDoc[] {
  const params: string[] = [];
  let where = "NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id)";
  if (bucket) {
    where += " AND b.name = ?";
    params.push(bucket);
  }
  return db
    .prepare(
      `SELECT d.id, d.doc_key AS key, d.title, b.name AS bucket, d.content
       FROM documents d JOIN buckets b ON b.id = d.bucket_id
       WHERE ${where} ORDER BY d.updated_at DESC`,
    )
    .all(...params) as UntaggedDoc[];
}
