import type { Database } from "bun:sqlite";
import type { KuraConfig } from "../config";
import type { FtsTokenizer } from "../db";
import { resolveProvider } from "../llm/provider";
import { expandQuery } from "./expand";
import { keywordSearch } from "./keyword";
import { rerankCandidates } from "./rerank";
import type { SearchHit } from "./types";
import { ensureEmbeddings, vectorSearchDetailed } from "./vector";

export interface HybridOptions {
  bucket?: string;
  tag?: string;
  limit?: number;
  /** LLM クエリ展開を有効化（`query --expand`） */
  expand?: boolean;
}

export interface HybridOutcome {
  hits: SearchHit[];
  warnings: string[];
  usedVector: boolean;
  usedRerank: boolean;
  expandedQueries: string[];
}

interface Fused {
  hit: SearchHit;
  rrfScore: number;
  chunkText: string | null;
}

const CANDIDATE_LIMIT = 50;

/** ポジション加重ブレンド（qmd 方式、SPEC §5.1）: RRF 上位ほど RRF を信頼する */
export function blendScores(rrfNormalized: number, rerank: number, rrfRank: number): number {
  if (rrfRank <= 3) return rrfNormalized * 0.75 + rerank * 0.25;
  if (rrfRank <= 10) return rrfNormalized * 0.6 + rerank * 0.4;
  return rrfNormalized * 0.4 + rerank * 0.6;
}

/**
 * ハイブリッド検索パイプライン: (展開) → FTS + ベクトル → RRF 融合 → リランク → ブレンド。
 * LLM 系が使えない場合は劣化動作で必ず応答する（エラーで落とさない、SPEC §5.1）。
 */
export async function hybridQuery(
  db: Database,
  tokenizer: FtsTokenizer,
  config: KuraConfig,
  query: string,
  opts: HybridOptions = {},
): Promise<HybridOutcome> {
  const warnings: string[] = [];
  const limit = opts.limit ?? config.search.default_limit;
  const filter = { bucket: opts.bucket, tag: opts.tag };
  const provider = await resolveProvider(config);
  const rrfK = config.search.rrf_k;

  // クエリ展開: 元クエリ重み 2 + バリアント重み 1（SPEC §5.1）
  const variants: Array<{ q: string; weight: number }> = [{ q: query, weight: 2 }];
  if (opts.expand) {
    if (!provider) {
      warnings.push("LLM プロバイダ不在のため --expand をスキップしました");
    } else {
      try {
        for (const v of await expandQuery(db, provider, config, query)) {
          variants.push({ q: v, weight: 1 });
        }
      } catch (e) {
        warnings.push(`クエリ展開に失敗しました（${e instanceof Error ? e.message : e}）`);
      }
    }
  }

  const fused = new Map<number, Fused>();
  const accumulate = (
    hits: SearchHit[],
    listWeight: number,
    variantWeight: number,
    chunkTexts?: Map<number, string>,
  ): void => {
    hits.forEach((hit, rank) => {
      const contribution = (listWeight * variantWeight) / (rrfK + rank + 1);
      const entry = fused.get(hit.docId);
      if (entry) {
        entry.rrfScore += contribution;
        entry.chunkText ??= chunkTexts?.get(hit.docId) ?? null;
      } else {
        fused.set(hit.docId, {
          hit: { ...hit, source: "hybrid" },
          rrfScore: contribution,
          chunkText: chunkTexts?.get(hit.docId) ?? null,
        });
      }
    });
  };

  for (const v of variants) {
    accumulate(
      keywordSearch(db, tokenizer, v.q, { ...filter, limit: CANDIDATE_LIMIT }),
      config.search.keyword_weight,
      v.weight,
    );
  }

  let usedVector = false;
  if (provider) {
    try {
      const warn = await ensureEmbeddings(db, provider, config);
      if (warn) warnings.push(warn);
      for (const v of variants) {
        const detailed = await vectorSearchDetailed(db, provider, config, v.q, {
          ...filter,
          limit: CANDIDATE_LIMIT,
        });
        const chunkTexts = new Map(detailed.map((d) => [d.hit.docId, d.chunkText]));
        accumulate(
          detailed.map((d) => d.hit),
          config.search.vector_weight,
          v.weight,
          chunkTexts,
        );
      }
      usedVector = true;
    } catch (e) {
      warnings.push(
        `ベクトル検索を利用できません（${e instanceof Error ? e.message : e}）。キーワード検索のみで応答します`,
      );
    }
  } else {
    warnings.push(
      "LLM プロバイダに接続できないため、キーワード検索のみで応答します（'kura doctor' で確認できます）",
    );
  }

  const ranked = [...fused.values()].sort((a, b) => b.rrfScore - a.rrfScore);
  const candidates = ranked.slice(0, config.search.rerank_top_k);
  const maxRrf = candidates[0]?.rrfScore ?? 1;

  // リランク（プロバイダ不在・失敗時は RRF 順のまま返す）
  let usedRerank = false;
  let finalOrder = candidates.map((c, i) => ({
    ...c,
    finalScore: c.rrfScore / maxRrf,
    rrfRank: i + 1,
  }));
  if (provider && candidates.length > 0) {
    try {
      const rerankInput = candidates.map((c) => ({
        docId: c.hit.docId,
        text: c.chunkText ?? candidateText(db, c.hit.docId),
      }));
      const scores = await rerankCandidates(db, provider, config, query, rerankInput);
      finalOrder = finalOrder.map((c) => ({
        ...c,
        finalScore: blendScores(c.rrfScore / maxRrf, scores.get(c.hit.docId) ?? 0.5, c.rrfRank),
      }));
      finalOrder.sort((a, b) => b.finalScore - a.finalScore);
      usedRerank = true;
    } catch (e) {
      warnings.push(
        `リランクに失敗しました（${e instanceof Error ? e.message : e}）。RRF 順で返します`,
      );
    }
  }

  const hits = finalOrder.slice(0, limit).map((c) => ({ ...c.hit, score: c.finalScore }));
  return {
    hits,
    warnings,
    usedVector,
    usedRerank,
    expandedQueries: variants.slice(1).map((v) => v.q),
  };
}

/** キーワード検索のみでヒットした候補のリランク用テキスト（先頭チャンク → 本文先頭） */
function candidateText(db: Database, docId: number): string {
  const chunk = db
    .prepare("SELECT text FROM chunks WHERE document_id = ? ORDER BY seq LIMIT 1")
    .get(docId) as { text: string } | null;
  if (chunk) return chunk.text;
  const doc = db.prepare("SELECT title, content FROM documents WHERE id = ?").get(docId) as {
    title: string;
    content: string;
  } | null;
  return doc ? `# ${doc.title}\n\n${doc.content.slice(0, 1600)}` : "";
}
