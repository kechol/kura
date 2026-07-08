import type { Database } from "bun:sqlite";
import type { KuraConfig } from "../config";
import { cached } from "../llm/cache";
import type { LLMProvider } from "../llm/provider";

const SYSTEM_PROMPT =
  'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".';

const INSTRUCT = "Given a web search query, retrieve relevant passages that answer the query";

/** Extract yes/no from the answer and map to 1/0; 0.5 when undecidable (Qwen3 <think> blocks are stripped) */
export function parseYesNo(answer: string): number {
  const cleaned = answer
    .replaceAll(/<think>[\s\S]*?<\/think>/gi, "")
    .trim()
    .toLowerCase();
  const m = cleaned.match(/\b(yes|no)\b/);
  if (!m) return 0.5;
  return m[1] === "yes" ? 1 : 0;
}

export interface RerankCandidate {
  docId: number;
  text: string;
}

const CONCURRENCY = 4;
const MAX_DOC_CHARS = 2000;

/**
 * Yes/no reranking via chat completions (parallel execution + llm_cache, SPEC §5.1).
 * Returns a map of docId to score (1 / 0 / 0.5).
 */
export async function rerankCandidates(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  query: string,
  candidates: RerankCandidate[],
): Promise<Map<number, number>> {
  const model = config.llm.models.reranker;
  const results = new Map<number, number>();
  let index = 0;

  async function worker(): Promise<void> {
    while (index < candidates.length) {
      const current = candidates[index++]!;
      const text = current.text.slice(0, MAX_DOC_CHARS);
      const score = await cached<number>(db, "rerank", model, `${query}\x00${text}`, async () => {
        const answer = await provider.chat(
          [
            { role: "system", content: SYSTEM_PROMPT },
            {
              role: "user",
              content: `<Instruct>: ${INSTRUCT}\n\n<Query>: ${query}\n\n<Document>: ${text}`,
            },
          ],
          model,
          { temperature: 0 },
        );
        return parseYesNo(answer);
      });
      results.set(current.docId, score);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () => worker()),
  );
  return results;
}
