import type { Database } from "bun:sqlite";
import type { KuraConfig } from "../config";
import { sha256Hex } from "../documents";
import { cached } from "../llm/cache";
import { type LLMProvider, stripThinkBlocks } from "../llm/provider";
import type { ExtractedPage } from "./extract";
import { htmlToMarkdown } from "./turndown";

export interface FormattedClip {
  title: string;
  markdown: string;
  /** Whether LLM formatting was used (false = mechanical turndown conversion) */
  llmFormatted: boolean;
}

/** Mechanical conversion via turndown (fallback for --no-llm / no provider) */
export { htmlToMarkdown } from "./turndown";

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
  const cleaned = stripThinkBlocks(answer);
  const m = cleaned.match(/^TITLE:\s*(.+)\n+([\s\S]*)$/);
  if (!m) return { title: fallbackTitle, markdown: cleaned };
  const title = (m[1] ?? "").trim() || fallbackTitle;
  return { title, markdown: (m[2] ?? "").trim() };
}

/**
 * Format clipped content (docs: cli-reference.md). Uses the LLM when available, turndown only otherwise.
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
