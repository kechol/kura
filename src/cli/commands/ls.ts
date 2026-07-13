import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { type ListFilter, listDocuments } from "../../core/documents";
import { staleDocuments } from "../../core/stale";
import { joinDocPath, normalizeDocPath } from "../../core/wiki";
import { boolOpt, EXIT, intOpt, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "List documents";

export const usage = `Usage: kura ls [--bucket b] [--tag t] [--prefix p] [--sort updated|created|accessed|title]
               [--stale] [--limit n] [--json]

Options:
  --bucket <name>   Only documents in this bucket (default: all buckets)
  --tag <path>      Only documents with this tag (descendants included)
  --prefix <path>   Only documents under this document path (descendants included)
  --sort <key>      updated (default) | created | accessed | title
  --stale           Only documents older than general.stale_days
  --limit <n>       Maximum number of documents
  --json            Machine-readable output`;

const SORTS = ["updated", "created", "accessed", "title"] as const;

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    tag: { type: "string" },
    prefix: { type: "string" },
    sort: { type: "string" },
    stale: { type: "boolean", default: false },
    limit: { type: "string" },
  });

  const sort = strOpt(parsed, "sort");
  if (sort !== undefined && !(SORTS as readonly string[]).includes(sort)) {
    throw new UsageError(`--sort must be one of ${SORTS.join("|")}, got: ${sort}`);
  }
  const rawPrefix = strOpt(parsed, "prefix");
  const prefix = rawPrefix === undefined ? undefined : normalizeDocPath(rawPrefix);
  if (prefix === "") throw new UsageError("--prefix must not be empty");

  const { db } = getDb();
  const config = loadConfig();
  const stale = boolOpt(parsed, "stale");
  let docs = listDocuments(db, {
    bucket: strOpt(parsed, "bucket"),
    tag: strOpt(parsed, "tag"),
    prefix,
    sort: sort as ListFilter["sort"],
    stale,
    staleDays: config.general.stale_days,
    limit: stale ? undefined : intOpt(parsed, "limit"),
  });
  if (stale) {
    // Filter and sort by staleness score (days elapsed × low access) (docs: self-healing.md)
    const scored = staleDocuments(db, config, { bucket: strOpt(parsed, "bucket") });
    const order = new Map(scored.map((s, i) => [s.key, i]));
    docs = docs
      .filter((d) => order.has(d.key))
      .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
    const limit = intOpt(parsed, "limit");
    if (limit !== undefined) docs = docs.slice(0, limit);
  }

  if (boolOpt(parsed, "json")) {
    const out = docs.map((d) => ({
      key: d.key,
      path: d.path,
      title: d.title,
      bucket: d.bucket,
      tags: d.tags,
      created_at: d.createdAt,
      updated_at: d.updatedAt,
      last_accessed_at: d.lastAccessedAt,
      access_count: d.accessCount,
    }));
    console.log(JSON.stringify(out, null, 2));
    return EXIT.OK;
  }

  for (const d of docs) {
    const parts = [`#${d.key}`, joinDocPath(d.path, d.title), `[${d.bucket}]`];
    if (d.tags.length > 0) parts.push(d.tags.join(","));
    parts.push(d.updatedAt);
    console.log(parts.join("  "));
  }
  console.log(`${docs.length} documents`);
  return EXIT.OK;
}
