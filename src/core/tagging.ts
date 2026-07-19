import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import { sha256Hex } from "./documents";
import { cached } from "./llm/cache";
import { parseJsonArray } from "./llm/parse";
import type { LLMProvider } from "./llm/provider";

/**
 * LLM tag suggestion (docs: cli-reference.md, self-healing.md). Extracted from
 * the clip pipeline so tag suggestion has an owner of its own; clip is now one
 * consumer among several. LLM-required, cached under purpose "tag".
 */

/** Content excerpt cap for the tag-suggestion prompt; shared with titling.ts */
export const EXCERPT_CHARS = 4000;

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const TAG_PROMPT = `あなたはナレッジベースのタグ付けアシスタントです。
記事に付けるタグを最大 5 つ提案してください。
**既存タグ一覧にあるタグを最優先で再利用**し、どうしても該当がない場合のみ新しいタグを作ってください。
階層タグは / 区切り（例: tech/db/sqlite）。日本語タグ可。
出力は JSON の文字列配列のみ（例: ["tech/db", "読書メモ"]）。`;

/** LLM tag suggestions (prefers existing tags, cached under purpose 'tag', docs: cli-reference.md, self-healing.md) */
export async function suggestTagsForText(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  text: string,
  existingTags: string[],
): Promise<string[]> {
  const model = config.llm.models.generation;
  const excerpt = text.slice(0, EXCERPT_CHARS);
  const tagList = existingTags.slice(0, 200).join(", ");
  return cached<string[]>(db, "tag", model, `${sha256Hex(excerpt)}\x00${tagList}`, async () => {
    const answer = await provider.chat(
      [
        { role: "system", content: TAG_PROMPT },
        { role: "user", content: `既存タグ一覧: ${tagList || "(なし)"}\n\n記事:\n${excerpt}` },
      ],
      model,
      { temperature: 0 },
    );
    const parsed = parseJsonArray<unknown[]>(answer);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === "string" && t.trim() !== "").slice(0, 5);
  });
}
