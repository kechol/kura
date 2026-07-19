import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import { type DocumentRecord, sha256Hex } from "./documents";
import { cached } from "./llm/cache";
import { parseJsonObject } from "./llm/parse";
import type { LLMProvider } from "./llm/provider";
import { EXCERPT_CHARS } from "./tagging";

/**
 * Title suggestion engine (docs: self-healing.md). One of the organizing
 * engines behind `kura triage` (per-document pipeline); the store-wide
 * `kura audit dupes` pass consumes the sibling dedupe engine. LLM-required and
 * cached under purpose "title"; degrades to a warning when no provider is
 * reachable (invariants R4).
 */

/** Titles longer than this are truncated; a title is a label, not a sentence */
const MAX_TITLE_CHARS = 120;

export interface TitleSuggestion {
  title: string;
  reason?: string;
}

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const TITLE_PROMPT = `あなたはナレッジベースの整理アシスタントです。
ドキュメントの内容にふさわしい、簡潔で具体的なタイトルを 1 つ提案してください。
- タイトルは本文と同じ言語で書いてください。
- 内容を的確に表す固有の名詞句にし、「メモ」「ドキュメント」のような汎用的すぎる語は避けてください。
- 現在のタイトルがすでに内容を的確に表している場合は、それをそのまま返してください。
出力は JSON のみ: {"title": "提案するタイトル", "reason": "一行の理由"}`;

/**
 * Suggest a concise, specific title for one document. Works with provider =
 * null (degraded operation, invariants R4); the parse failures fail soft into
 * warnings. Returns a null suggestion (no warning) when the model proposes the
 * current title unchanged.
 */
export async function suggestTitleForDocument(
  db: Database,
  provider: LLMProvider | null,
  config: KuraConfig,
  doc: DocumentRecord,
): Promise<{ suggestion: TitleSuggestion | null; warnings: string[] }> {
  if (!provider) {
    return { suggestion: null, warnings: ["no LLM provider available; skipping title suggestion"] };
  }

  const model = config.llm.models.generation;
  const excerpt = doc.content.slice(0, EXCERPT_CHARS);
  const answer = await cached<string>(
    db,
    "title",
    model,
    `${sha256Hex(excerpt)}\x00${doc.title}`,
    () =>
      provider.chat(
        [
          { role: "system", content: TITLE_PROMPT },
          { role: "user", content: `現在のタイトル: ${doc.title}\n\n本文:\n${excerpt}` },
        ],
        model,
        { temperature: 0 },
      ),
  );

  const parsed = parseJsonObject<{ title?: unknown; reason?: unknown }>(answer);
  if (!parsed) {
    // Distinguish "no JSON at all" from "a {...} block that failed to parse".
    const warning = /\{[\s\S]*?\}/.test(answer)
      ? "title suggestion returned malformed JSON"
      : "title suggestion returned no parseable JSON";
    return { suggestion: null, warnings: [warning] };
  }
  const proposed = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (proposed === "") {
    return { suggestion: null, warnings: ["title suggestion returned an empty title"] };
  }
  // The model was asked to echo an already-good title; that is not a suggestion.
  if (proposed === doc.title) return { suggestion: null, warnings: [] };
  const reason = typeof parsed.reason === "string" ? parsed.reason : undefined;
  return { suggestion: { title: proposed.slice(0, MAX_TITLE_CHARS), reason }, warnings: [] };
}
