import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { staleDocuments } from "../../core/stale";
import { collectStats } from "../../core/stats";
import { boolOpt, EXIT, parseCommandArgs } from "../args";

export const summary = "Show knowledge base statistics";

export const usage = "Usage: kura status [--json]";

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv);
  const config = loadConfig();
  const { db, tokenizer } = getDb();
  const stats = collectStats(db, config);
  const stale = staleDocuments(db, config, { limit: 5 });

  if (boolOpt(parsed, "json")) {
    console.log(JSON.stringify({ ...stats, staleTop: stale }, null, 2));
    return EXIT.OK;
  }

  console.log(`documents:  ${stats.documents}`);
  for (const b of stats.buckets) {
    console.log(`  ${b.name.padEnd(16)} ${b.documents}`);
  }
  console.log(`tags:       ${stats.tags}`);
  console.log(
    `embedding:  ${stats.embeddedChunks}/${stats.chunks} chunks (${(stats.embeddingCoverage * 100).toFixed(1)}%)${stats.embeddingModel ? ` model: ${stats.embeddingModel}` : ""}`,
  );
  console.log(
    `stale:      ${stats.staleDocuments} documents (updated > ${config.general.stale_days}d ago)`,
  );
  if (stale.length > 0) {
    for (const d of stale) {
      console.log(
        `  #${d.key}  ${d.title}  (${d.daysSinceUpdate}d, ${d.accessCount} reads, score ${d.staleScore.toFixed(1)})`,
      );
    }
  }
  console.log(`broken:     ${stats.unresolvedLinks} unresolved links`);
  console.log(`db:         ${formatBytes(stats.dbSizeBytes)} / tokenizer: ${tokenizer}`);
  return EXIT.OK;
}
