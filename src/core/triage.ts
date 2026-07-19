import type { Database } from "bun:sqlite";
import type { KuraConfig } from "./config";
import type { FtsTokenizer } from "./db";
import { type DupeCandidate, exactDuplicates, nearDuplicates } from "./dedupe";
import { type DocumentRecord, UNFILED_WHERE, UNTAGGED_WHERE, UNTRIAGED_WHERE } from "./documents";
import { suggestedPath, suggestPathForDocument } from "./filing";
import { type LinkSuggestion, suggestLinksForDocument } from "./linking";
import type { LLMProvider } from "./llm/provider";
import { suggestTagsForText } from "./tagging";
import { listTags } from "./tags";
import { suggestTitleForDocument, type TitleSuggestion } from "./titling";

/**
 * Per-document triage pipeline (docs: self-healing.md). Runs the organizing
 * engines — dedupe, title, tags, path, links — over one document and returns a
 * pure suggestion report; it performs no writes and no console output, so the
 * CLI (`kura triage`) owns confirmation and application. Every engine degrades
 * when no provider is reachable (invariants R4); their warnings are aggregated
 * and de-duplicated here.
 */

export const TRIAGE_STEPS = ["dedupe", "title", "tags", "path", "links"] as const;
export type TriageStep = (typeof TRIAGE_STEPS)[number];

export interface TriageReport {
  doc: DocumentRecord;
  /** Present only when at least one duplicate candidate was found */
  dedupe?: { candidates: DupeCandidate[] };
  /** null = the title step ran but proposed no change */
  title?: TitleSuggestion | null;
  /** Suggested tags, minus tags already on the document */
  tags?: string[];
  /** null = the path step ran but found no signal; absent when the doc is already filed */
  path?: { path: string; source: "llm" | "signals"; reason?: string } | null;
  links?: LinkSuggestion[];
  warnings: string[];
}

/**
 * Ids of the documents awaiting a triage pass in a bucket. The backlog is
 * (unfiled OR untagged) AND — unless `redo` — (never triaged OR edited since the
 * last pass), newest-updated first (docs: self-healing.md). Returns bare ids: the
 * CLI re-fetches each document fresh as it processes it, so materializing full
 * records here (extra tag/alias/content queries per row) would be wasted work.
 * Predicates are the canonical UNFILED_WHERE / UNTAGGED_WHERE / UNTRIAGED_WHERE
 * (src/core/documents.ts).
 */
export function listTriageBacklog(
  db: Database,
  bucket: string,
  opts: { redo?: boolean; limit?: number } = {},
): number[] {
  const clauses = ["b.name = ?", `(${UNFILED_WHERE} OR ${UNTAGGED_WHERE})`];
  if (!opts.redo) {
    clauses.push(UNTRIAGED_WHERE);
  }
  const params: Array<string | number> = [bucket];
  let sql = `SELECT d.id FROM documents d JOIN buckets b ON b.id = d.bucket_id
     WHERE ${clauses.join(" AND ")} ORDER BY d.updated_at DESC`;
  if (opts.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(opts.limit);
  }
  return (db.prepare(sql).all(...params) as Array<{ id: number }>).map((r) => r.id);
}

/**
 * Run the requested organizing steps over one document, in TRIAGE_STEPS order.
 * Pure: no writes, no output. Provider = null still runs every step (each engine
 * degrades to structural / keyword signals or skips with a warning).
 */
export async function triageDocument(
  db: Database,
  tokenizer: FtsTokenizer,
  config: KuraConfig,
  provider: LLMProvider | null,
  doc: DocumentRecord,
  steps: readonly TriageStep[],
): Promise<TriageReport> {
  const report: TriageReport = { doc, warnings: [] };
  const warnings: string[] = [];

  for (const step of TRIAGE_STEPS) {
    if (!steps.includes(step)) continue;
    switch (step) {
      case "dedupe": {
        const exact: DupeCandidate[] = exactDuplicates(db, doc).map((d) => ({
          doc: d,
          similarity: 1,
          exact: true,
        }));
        const near = await nearDuplicates(db, provider, config, doc);
        warnings.push(...near.warnings);
        const candidates = [...exact, ...near.candidates];
        if (candidates.length > 0) report.dedupe = { candidates };
        break;
      }
      case "title": {
        const { suggestion, warnings: w } = await suggestTitleForDocument(
          db,
          provider,
          config,
          doc,
        );
        warnings.push(...w);
        report.title = suggestion;
        break;
      }
      case "tags": {
        if (!provider) {
          warnings.push("no LLM provider available; skipping tag suggestion");
          break;
        }
        try {
          const existing = listTags(db).map((t) => t.path);
          const suggested = await suggestTagsForText(
            db,
            provider,
            config,
            `${doc.title}\n\n${doc.content}`,
            existing,
          );
          const onDoc = new Set(doc.tags);
          report.tags = suggested.filter((t) => !onDoc.has(t));
        } catch (e) {
          warnings.push(`tag suggestion failed (${e instanceof Error ? e.message : e})`);
        }
        break;
      }
      case "path": {
        // Triage proposes filing, never re-filing: skip documents already filed.
        if (doc.path !== "") break;
        const suggestion = await suggestPathForDocument(db, tokenizer, config, provider, doc);
        warnings.push(...suggestion.warnings);
        const chosen = suggestedPath(suggestion);
        report.path =
          chosen === null
            ? null
            : {
                path: chosen,
                source: suggestion.llm ? "llm" : "signals",
                ...(suggestion.llm?.reason ? { reason: suggestion.llm.reason } : {}),
              };
        break;
      }
      case "links": {
        const { suggestions, warnings: w } = await suggestLinksForDocument(
          db,
          tokenizer,
          provider,
          config,
          doc,
        );
        warnings.push(...w);
        report.links = suggestions;
        break;
      }
    }
  }

  report.warnings = [...new Set(warnings)];
  return report;
}
