import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { requireProvider } from "../../core/llm/provider";
import { ensureEmbeddings, vectorSearch } from "../../core/search/vector";
import { boolOpt, EXIT, intOpt, parseCommandArgs, strOpt, UsageError } from "../args";
import { printHits } from "../searchOutput";

export const summary = "Semantic vector search (KNN)";

export const usage = `Usage: kura vsearch "クエリ" [--bucket b] [--tag t] [--limit 20] [--json]

Requires an embedding provider (Ollama / LM Studio).`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    tag: { type: "string" },
    limit: { type: "string" },
  });
  const query = parsed.positionals.join(" ").trim();
  if (query === "") throw new UsageError("search query is required");
  const config = loadConfig();
  const { db } = getDb();
  const provider = await requireProvider(config);

  const warning = await ensureEmbeddings(db, provider, config);
  if (warning) console.error(`warning: ${warning}`);

  const hits = await vectorSearch(db, provider, config, query, {
    bucket: strOpt(parsed, "bucket"),
    tag: strOpt(parsed, "tag"),
    limit: intOpt(parsed, "limit") ?? 20,
  });
  printHits(hits, boolOpt(parsed, "json"));
  return EXIT.OK;
}
