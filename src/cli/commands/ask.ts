import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { askQuestion } from "../../core/search/ask";
import { joinDocPath } from "../../core/wiki";
import { boolOpt, EXIT, intOpt, parseCommandArgs, strOpt, UsageError } from "../args";
import { isColorEnabled, renderMarkdown } from "../render";
import { printHits } from "../searchOutput";

export const summary = "Answer a question from the knowledge base (cited sources)";

export const usage = `Usage: kura ask "<question>" [--bucket b] [--tag t] [--expand] [--limit 10] [--json]

Runs a hybrid search, then answers the question strictly from the top hits,
citing them as [1], [2], ... Falls back to plain search results when no LLM
provider is available.

Options:
  --expand   Expand the query with an LLM to improve recall`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    tag: { type: "string" },
    expand: { type: "boolean", default: false },
    limit: { type: "string" },
  });
  const question = parsed.positionals.join(" ").trim();
  if (question === "") throw new UsageError("a question is required");
  const config = loadConfig();
  const { db, tokenizer } = getDb();

  const outcome = await askQuestion(db, tokenizer, config, question, {
    bucket: strOpt(parsed, "bucket"),
    tag: strOpt(parsed, "tag"),
    expand: boolOpt(parsed, "expand"),
    limit: intOpt(parsed, "limit") ?? config.search.default_limit,
  });
  for (const w of outcome.warnings) console.error(`warning: ${w}`);

  if (boolOpt(parsed, "json")) {
    console.log(
      JSON.stringify(
        {
          answer: outcome.answer,
          sources: outcome.sources.map((s, i) => ({
            n: i + 1,
            key: s.key,
            path: s.path,
            title: s.title,
            bucket: s.bucket,
          })),
          hits: outcome.hits.map((h) => ({ key: h.key, title: h.title, bucket: h.bucket })),
        },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }

  // Degraded: no answer — behave like kura query and list the hits
  if (outcome.answer === null) {
    printHits(outcome.hits, false);
    return EXIT.OK;
  }

  if (process.stdout.isTTY === true) {
    console.log(renderMarkdown(outcome.answer, { color: isColorEnabled() }));
  } else {
    console.log(outcome.answer);
  }
  if (outcome.sources.length > 0) {
    console.log("\nsources:");
    for (const [i, s] of outcome.sources.entries()) {
      console.log(`  [${i + 1}] #${s.key}  ${joinDocPath(s.path, s.title)}  [${s.bucket}]`);
    }
  }
  return EXIT.OK;
}
