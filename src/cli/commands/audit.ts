import { findContradictions, pairLabel } from "../../core/audit";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { requireProvider } from "../../core/llm/provider";
import { ensureEmbeddings } from "../../core/search/vector";
import { boolOpt, EXIT, intOpt, parseCommandArgs, strOpt } from "../args";

export const summary = "Audit the knowledge base for contradictions (requires an LLM)";

export const usage = `Usage: kura audit [--bucket b] [--limit 10] [--json]

Finds semantically close passages from different documents among the most
recently updated ones and asks the generation model whether they contradict
each other. Verdicts are cached, so re-runs only pay for changed content.
Requires a reachable LLM provider (exit 4 otherwise).

Options:
  --limit <n>   Maximum candidate pairs to judge (default 10)`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    limit: { type: "string" },
  });
  const config = loadConfig();
  const { db } = getDb();
  const provider = await requireProvider(config);
  const warn = await ensureEmbeddings(db, provider, config);
  if (warn) console.error(`warning: ${warn}`);

  const outcome = await findContradictions(db, provider, config, {
    bucket: strOpt(parsed, "bucket"),
    limit: intOpt(parsed, "limit"),
  });
  const contradictions = outcome.pairs.filter((p) => p.contradictory);

  if (boolOpt(parsed, "json")) {
    console.log(
      JSON.stringify(
        {
          examined_pairs: outcome.examinedPairs,
          contradictions: contradictions.map((p) => ({
            a: {
              key: p.a.key,
              title: p.a.title,
              path: p.a.path,
              bucket: p.a.bucket,
              excerpt: p.a.excerpt,
            },
            b: {
              key: p.b.key,
              title: p.b.title,
              path: p.b.path,
              bucket: p.b.bucket,
              excerpt: p.b.excerpt,
            },
            similarity: Number(p.similarity.toFixed(4)),
          })),
        },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }

  if (contradictions.length === 0) {
    console.log(`no contradictions found (${outcome.examinedPairs} pair(s) examined)`);
    return EXIT.OK;
  }
  for (const p of contradictions) {
    console.log(`⚠ ${pairLabel(p)}  (similarity ${p.similarity.toFixed(3)})`);
    console.log(`    A: ${p.a.excerpt}`);
    console.log(`    B: ${p.b.excerpt}`);
  }
  console.log(`${contradictions.length} contradiction(s) among ${outcome.examinedPairs} pair(s)`);
  return EXIT.OK;
}
