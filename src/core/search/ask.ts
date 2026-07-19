import type { Database } from "bun:sqlite";
import type { KuraConfig } from "../config";
import type { FtsTokenizer } from "../db";
import { cached } from "../llm/cache";
import { resolveProvider } from "../llm/provider";
import { joinDocPath } from "../wiki";
import { type HybridOptions, hybridQuery } from "./hybrid";
import type { SearchHit } from "./types";

export interface AskOutcome {
  /** Generated answer; null in degraded mode (the hits then stand in as the result) */
  answer: string | null;
  /** Sources passed to the model, in citation order ([1] = sources[0]) */
  sources: SearchHit[];
  /** Remaining hybrid hits beyond the cited sources */
  hits: SearchHit[];
  warnings: string[];
}

/** Documents shown to the model, and the per-document character budget */
const MAX_SOURCES = 5;
const MAX_SOURCE_CHARS = 1600;

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const PROMPT = `あなたはローカルナレッジベースの内容だけを根拠に回答するアシスタントです。
与えられた資料を根拠として質問に答えてください。

- 資料にない情報は推測で補わないでください。資料に根拠がない場合は「ナレッジベースに該当する情報が見つかりませんでした」と答えてください。
- 根拠にした資料は文末に [1] の形式で引用してください（複数可: [1][3]）。
- 回答は簡潔な日本語で書いてください。`;

interface SourceDoc {
  hit: SearchHit;
  text: string;
  contentHash: string;
}

function sourceDocs(db: Database, hits: SearchHit[]): SourceDoc[] {
  const stmt = db.prepare("SELECT content, content_hash FROM documents WHERE id = ?");
  const sources: SourceDoc[] = [];
  for (const hit of hits.slice(0, MAX_SOURCES)) {
    const row = stmt.get(hit.docId) as { content: string; content_hash: string } | null;
    if (!row) continue;
    sources.push({
      hit,
      text: `# ${joinDocPath(hit.path, hit.title)}\n\n${row.content.slice(0, MAX_SOURCE_CHARS)}`,
      contentHash: row.content_hash,
    });
  }
  return sources;
}

/**
 * Answer a question from the knowledge base with cited sources
 * (docs: search-pipeline.md): hybrid search -> top hits become numbered
 * sources -> the generation model answers strictly from them. Degrades to
 * plain hybrid results when no provider is reachable (invariants R4) — the
 * caller shows the hits instead of an answer. Answers are cached in
 * llm_cache keyed on the question plus the sources' content hashes, so a
 * changed document invalidates the cache.
 */
export async function askQuestion(
  db: Database,
  tokenizer: FtsTokenizer,
  config: KuraConfig,
  question: string,
  opts: HybridOptions = {},
): Promise<AskOutcome> {
  const outcome = await hybridQuery(db, tokenizer, config, question, opts);
  const warnings = [...outcome.warnings];
  const provider = await resolveProvider(config);

  if (outcome.hits.length === 0) {
    return { answer: null, sources: [], hits: [], warnings };
  }
  if (!provider) {
    warnings.push("cannot generate an answer without an LLM provider; showing search results only");
    return { answer: null, sources: [], hits: outcome.hits, warnings };
  }

  const sources = sourceDocs(db, outcome.hits);
  const materials = sources.map((s, i) => `[${i + 1}] ${s.text}`).join("\n\n---\n\n");
  const model = config.llm.models.generation;
  const cacheInput = `${question}\x00${sources.map((s) => `${s.hit.key}:${s.contentHash}`).join(",")}`;

  try {
    const answer = await cached<string>(db, "ask", model, cacheInput, async () => {
      const raw = await provider.chat(
        [
          { role: "system", content: PROMPT },
          { role: "user", content: `資料:\n\n${materials}\n\n質問: ${question}` },
        ],
        model,
        { temperature: 0.2 },
      );
      // Qwen3-style think blocks are reasoning, not answer
      return raw.replaceAll(/<think>[\s\S]*?<\/think>/gi, "").trim();
    });
    return {
      answer,
      sources: sources.map((s) => s.hit),
      hits: outcome.hits.slice(sources.length),
      warnings,
    };
  } catch (e) {
    warnings.push(
      `answer generation failed (${e instanceof Error ? e.message : e}); showing search results only`,
    );
    return { answer: null, sources: [], hits: outcome.hits, warnings };
  }
}
