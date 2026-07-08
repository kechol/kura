import type { Database } from "bun:sqlite";
import TurndownService from "turndown";
import type { KuraConfig } from "../config";
import { sha256Hex } from "../documents";
import { cached } from "../llm/cache";
import type { LLMProvider } from "../llm/provider";
import type { ExtractedPage } from "./extract";

export interface FormattedClip {
  title: string;
  markdown: string;
  /** Whether LLM formatting was used (false = mechanical turndown conversion) */
  llmFormatted: boolean;
}

/** Mechanical conversion via turndown (fallback for --no-llm / no provider) */
export function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.remove(["script", "style", "iframe", "noscript"]);
  return turndown.turndown(html).trim();
}

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const FORMAT_PROMPT = `あなたは Web 記事をナレッジベース用の Markdown に整形するアシスタントです。
入力は Web ページから機械変換した Markdown です。以下を行ってください:
- 広告・ナビゲーション・SNS ボタン・購読案内などの残骸を除去する
- 見出し構造を正規化する（記事タイトルは含めない。本文は ## 以下から始める）
- 本文の文言は改変しない（要約しない。削るのはノイズのみ）
- コードブロック・リンク・画像は保持する

出力は次の形式のみ:
1 行目: TITLE: <記事の正確なタイトル>
2 行目以降: 整形済み Markdown 本文`;

function parseFormatted(
  answer: string,
  fallbackTitle: string,
): { title: string; markdown: string } {
  const cleaned = answer.replaceAll(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const m = cleaned.match(/^TITLE:\s*(.+)\n+([\s\S]*)$/);
  if (!m) return { title: fallbackTitle, markdown: cleaned };
  const title = (m[1] ?? "").trim() || fallbackTitle;
  return { title, markdown: (m[2] ?? "").trim() };
}

/**
 * Format clipped content (SPEC §7.5). Uses the LLM when available, turndown only otherwise.
 * LLM responses are cached in llm_cache (purpose 'clip').
 */
export async function formatClip(
  db: Database,
  provider: LLMProvider | null,
  config: KuraConfig,
  page: ExtractedPage,
  opts: { noLlm?: boolean } = {},
): Promise<FormattedClip> {
  const raw = htmlToMarkdown(page.contentHtml);
  if (opts.noLlm || !provider) {
    return { title: page.title, markdown: raw, llmFormatted: false };
  }

  const model = config.llm.models.generation;
  // Trim very long articles so the input fits into the model context
  const input = raw.slice(0, 24_000);
  const cacheInput = `${page.url}\x00${sha256Hex(raw)}`;
  try {
    const result = await cached<{ title: string; markdown: string }>(
      db,
      "clip",
      model,
      cacheInput,
      async () => {
        const answer = await provider.chat(
          [
            { role: "system", content: FORMAT_PROMPT },
            { role: "user", content: `元タイトル候補: ${page.title}\n\n${input}` },
          ],
          model,
          { temperature: 0 },
        );
        return parseFormatted(answer, page.title);
      },
    );
    if (result.markdown.length < 40) {
      // If the LLM dropped the body, keep the mechanical conversion
      return { title: result.title, markdown: raw, llmFormatted: false };
    }
    return { ...result, llmFormatted: true };
  } catch {
    return { title: page.title, markdown: raw, llmFormatted: false };
  }
}

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const TAG_PROMPT = `あなたはナレッジベースのタグ付けアシスタントです。
記事に付けるタグを最大 5 つ提案してください。
**既存タグ一覧にあるタグを最優先で再利用**し、どうしても該当がない場合のみ新しいタグを作ってください。
階層タグは / 区切り（例: tech/db/sqlite）。日本語タグ可。
出力は JSON の文字列配列のみ（例: ["tech/db", "読書メモ"]）。`;

/** LLM tag suggestions (prefers existing tags, cached under purpose 'tag', SPEC §7.5/§10.3) */
export async function suggestTagsForText(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  text: string,
  existingTags: string[],
): Promise<string[]> {
  const model = config.llm.models.generation;
  const excerpt = text.slice(0, 4000);
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
    const m = answer.match(/\[[\s\S]*?\]/);
    if (!m) return [];
    try {
      const parsed = JSON.parse(m[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((t): t is string => typeof t === "string" && t.trim() !== "")
        .slice(0, 5);
    } catch {
      return [];
    }
  });
}
