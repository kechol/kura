import type { Database } from "bun:sqlite";
import type { KuraConfig } from "../config";
import { cached } from "../llm/cache";
import type { LLMProvider } from "../llm/provider";

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const PROMPT = `あなたは検索クエリの言い換えを作るアシスタントです。
与えられた検索クエリに対し、同じ意図を別の語彙で表したバリアントを 2 つ生成してください。
出力は JSON の文字列配列のみ（例: ["バリアント1", "バリアント2"]）。説明は不要です。`;

function parseVariants(answer: string, original: string): string[] {
  const m = answer.match(/\[[\s\S]*?\]/);
  if (!m) return [];
  try {
    const parsed = JSON.parse(m[0]);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set([original.toLowerCase()]);
    const variants: string[] = [];
    for (const v of parsed) {
      if (typeof v !== "string") continue;
      const t = v.trim();
      if (t === "" || seen.has(t.toLowerCase())) continue;
      seen.add(t.toLowerCase());
      variants.push(t);
    }
    return variants.slice(0, 2);
  } catch {
    return [];
  }
}

/** LLM query expansion: returns up to 2 variants (llm_cache required, SPEC §5.1) */
export async function expandQuery(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  query: string,
): Promise<string[]> {
  const model = config.llm.models.generation;
  return cached<string[]>(db, "expand", model, query, async () => {
    const answer = await provider.chat(
      [
        { role: "system", content: PROMPT },
        { role: "user", content: query },
      ],
      model,
      { temperature: 0.3 },
    );
    return parseVariants(answer, query);
  });
}
