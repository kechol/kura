import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { hybridQuery } from "../../core/search/hybrid";
import { boolOpt, EXIT, intOpt, parseCommandArgs, strOpt, UsageError } from "../args";
import { printHits } from "../searchOutput";

export const summary = "Hybrid RAG search (FTS + vector + rerank)";

export const usage = `Usage: kura query "<query>" [--bucket b] [--tag t] [--expand] [--limit 10] [--json]

Options:
  --expand   Expand the query with an LLM to improve recall

Falls back to keyword-only search when no LLM provider is available.`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    tag: { type: "string" },
    expand: { type: "boolean", default: false },
    limit: { type: "string" },
  });
  const query = parsed.positionals.join(" ").trim();
  if (query === "") throw new UsageError("search query is required");
  const config = loadConfig();
  const { db, tokenizer } = getDb();

  const outcome = await hybridQuery(db, tokenizer, config, query, {
    bucket: strOpt(parsed, "bucket"),
    tag: strOpt(parsed, "tag"),
    expand: boolOpt(parsed, "expand"),
    limit: intOpt(parsed, "limit") ?? config.search.default_limit,
  });
  for (const w of outcome.warnings) console.error(`warning: ${w}`);
  printHits(outcome.hits, boolOpt(parsed, "json"));
  return EXIT.OK;
}
