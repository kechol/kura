import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import type { FtsTokenizer } from "./db";
import { type DocumentRecord, getDocumentByKey } from "./documents";
import { outlinks } from "./links";
import { cached, pairKey } from "./llm/cache";
import type { LLMProvider } from "./llm/provider";
import { keywordSearch } from "./search/keyword";
import { parseYesNo } from "./search/rerank";
import { vectorSearch } from "./search/vector";

/**
 * Wiki-link suggestion engine (docs: self-healing.md). Consumed by the
 * per-document `kura triage` pipeline (propose relations for one document) and,
 * alongside the dedupe engine, by the store-wide `kura audit dupes` pass.
 * Candidate discovery degrades from semantic neighbours to FTS keyword matches
 * when no provider is reachable; the LLM relatedness verdict is cached under
 * purpose "link" (invariants R4).
 */

/** Default number of suggestions returned */
const DEFAULT_LIMIT = 3;

/** Candidates pulled from search before exclusions, per discovery path */
const DISCOVERY_LIMIT = 10;

/** Remaining candidates handed to the LLM relatedness verdict */
const MAX_JUDGE_CANDIDATES = 5;

/** Characters of each document shown to the relatedness judge */
const JUDGE_CHARS = 600;

export interface LinkSuggestion {
  doc: DocumentRecord;
  similarity: number;
  source: "vector" | "keyword";
}

// Intentionally Japanese — kura is a Japanese-first knowledge tool; this prompt is tuned for Japanese content.
const LINK_PROMPT = `あなたはナレッジベースの関連付けアシスタントです。
2 つの文書を提示します。一方を読む読者にとって、もう一方も参照する価値があるほど内容が関連しているかを判定してください。
- 単に語句が似ている、話題が広く重なるだけでは不十分です。
- 内容が実質的に関連し、相互にリンクする価値がある場合のみ「yes」と答えてください。
- 回答は「yes」または「no」のみ。説明は不要です。`;

// Intentionally Japanese — the heading is written into the user's Japanese-first content.
const RELATED_HEADING = "## 関連";

interface Candidate {
  doc: DocumentRecord;
  similarity: number;
  source: "vector" | "keyword";
}

/** Semantic neighbours (title + content excerpt as the query, like filing.ts) */
async function vectorCandidates(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  doc: DocumentRecord,
): Promise<Candidate[]> {
  const query = `${doc.title}\n${doc.content.slice(0, 1000)}`;
  const hits = await vectorSearch(db, provider, config, query, {
    bucket: doc.bucket,
    limit: DISCOVERY_LIMIT,
  });
  return toCandidates(db, hits, "vector");
}

/** FTS keyword neighbours (title as the query), the provider-free fallback */
function keywordCandidates(
  db: Database,
  tokenizer: FtsTokenizer,
  doc: DocumentRecord,
): Candidate[] {
  const hits = keywordSearch(db, tokenizer, doc.title, {
    bucket: doc.bucket,
    limit: DISCOVERY_LIMIT,
  });
  return toCandidates(db, hits, "keyword");
}

function toCandidates(
  db: Database,
  hits: Array<{ key: string; score: number }>,
  source: "vector" | "keyword",
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const hit of hits) {
    const record = getDocumentByKey(db, hit.key);
    if (record) candidates.push({ doc: record, similarity: hit.score, source });
  }
  return candidates;
}

/** Ask the model whether two documents are related enough to link */
async function judgeLink(
  db: Database,
  provider: LLMProvider,
  config: KuraConfig,
  doc: DocumentRecord,
  cand: DocumentRecord,
): Promise<boolean> {
  const model = config.llm.models.generation;
  const aText = `${doc.title}\n${doc.content.slice(0, JUDGE_CHARS)}`;
  const bText = `${cand.title}\n${cand.content.slice(0, JUDGE_CHARS)}`;
  // Symmetric verdict, so an unordered content-hash pair key is order-safe.
  const cacheInput = pairKey(doc.contentHash, cand.contentHash);
  const score = await cached<number>(db, "link", model, cacheInput, async () => {
    const answer = await provider.chat(
      [
        { role: "system", content: LINK_PROMPT },
        { role: "user", content: `文書A:\n${aText}\n\n文書B:\n${bText}` },
      ],
      model,
      { temperature: 0 },
    );
    return parseYesNo(answer);
  });
  return score === 1;
}

/**
 * Suggest wiki-link targets for one document. With a provider, semantic
 * neighbours are judged for relatedness (only "yes" kept); without one, the top
 * FTS keyword neighbours are returned unjudged plus a warning (invariants R4).
 * The document itself and anything it already links to are excluded.
 */
export async function suggestLinksForDocument(
  db: Database,
  tokenizer: FtsTokenizer,
  provider: LLMProvider | null,
  config: KuraConfig,
  doc: DocumentRecord,
  opts: { limit?: number } = {},
): Promise<{ suggestions: LinkSuggestion[]; warnings: string[] }> {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const warnings: string[] = [];

  // Exclude the document itself and every document it already links to.
  const excluded = new Set<string>([doc.key]);
  for (const link of outlinks(db, doc.id)) {
    if (link.target) excluded.add(link.target.key);
  }

  let candidates: Candidate[];
  if (provider) {
    candidates = await vectorCandidates(db, provider, config, doc);
  } else {
    warnings.push(
      "no LLM provider available; using keyword candidates without a relatedness check",
    );
    candidates = keywordCandidates(db, tokenizer, doc);
  }
  candidates = candidates
    .filter((c) => !excluded.has(c.doc.key))
    .sort((a, b) => b.similarity - a.similarity);

  if (!provider) {
    return { suggestions: candidates.slice(0, limit), warnings };
  }

  const judged = await Promise.all(
    candidates.slice(0, MAX_JUDGE_CANDIDATES).map(async (c) => {
      try {
        return (await judgeLink(db, provider, config, doc, c.doc)) ? c : null;
      } catch (e) {
        warnings.push(
          `link verdict failed for #${c.doc.key} (${e instanceof Error ? e.message : e})`,
        );
        return null;
      }
    }),
  );
  const suggestions = judged.filter((c): c is Candidate => c !== null).slice(0, limit);
  return { suggestions, warnings };
}

/**
 * Append `- [[Title]]` bullets under a trailing `## 関連` heading. Creates the
 * heading (preceded by a blank line) when absent; otherwise appends only the
 * titles not already listed under it. Pure and byte-preserving: existing content
 * and its trailing-newline state are untouched.
 */
export function appendRelatedLinks(content: string, titles: string[]): string {
  const wanted = titles.map((t) => t.trim()).filter((t) => t !== "");
  if (wanted.length === 0) return content;

  const bulletFor = (t: string) => `- [[${t}]]`;
  const lines = content.split("\n");
  const headingIdx = lines.findLastIndex((l) => l.trim() === RELATED_HEADING);

  if (headingIdx === -1) {
    const block = `${RELATED_HEADING}\n${wanted.map(bulletFor).join("\n")}\n`;
    const base = content.replace(/\s*$/, "");
    return base === "" ? block : `${base}\n\n${block}`;
  }

  // Section spans from the heading to the next level-1/2 heading (or EOF).
  let end = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,2}\s/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }

  const bulletRe = /^\s*-\s*\[\[([^\]]+)\]\]\s*$/;
  const existing = new Set<string>();
  let insertAt = headingIdx + 1;
  for (let i = headingIdx + 1; i < end; i++) {
    const line = lines[i] ?? "";
    const m = line.match(bulletRe);
    if (m) existing.add(m[1]?.trim() ?? "");
    if (line.trim() !== "") insertAt = i + 1;
  }

  const toAdd = wanted.filter((t) => !existing.has(t));
  if (toAdd.length === 0) return content;
  lines.splice(insertAt, 0, ...toAdd.map(bulletFor));
  return lines.join("\n");
}
