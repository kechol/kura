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
  /** LLM 整形を使ったか（false = turndown 機械変換） */
  llmFormatted: boolean;
}

/** turndown による機械変換（--no-llm / プロバイダ不在時のフォールバック） */
export function htmlToMarkdown(html: string): string {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.remove(["script", "style", "iframe", "noscript"]);
  return turndown.turndown(html).trim();
}

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
 * clip 本文の整形（SPEC §7.5）。LLM があれば整形、なければ turndown のみ。
 * LLM 応答は llm_cache（purpose 'clip'）にキャッシュされる。
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
  // 長大な記事はコンテキストに収まる範囲へ切り詰めて整形する
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
      // LLM が本文を落とした場合は機械変換を採用
      return { title: result.title, markdown: raw, llmFormatted: false };
    }
    return { ...result, llmFormatted: true };
  } catch {
    return { title: page.title, markdown: raw, llmFormatted: false };
  }
}

const TAG_PROMPT = `あなたはナレッジベースのタグ付けアシスタントです。
記事に付けるタグを最大 5 つ提案してください。
**既存タグ一覧にあるタグを最優先で再利用**し、どうしても該当がない場合のみ新しいタグを作ってください。
階層タグは / 区切り（例: tech/db/sqlite）。日本語タグ可。
出力は JSON の文字列配列のみ（例: ["tech/db", "読書メモ"]）。`;

/** LLM によるタグ提案（既存タグ優先、purpose 'tag' でキャッシュ、SPEC §7.5/§10.3） */
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
