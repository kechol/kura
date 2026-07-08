import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { keywordSearch } from "../../core/search/keyword";
import { boolOpt, EXIT, intOpt, parseCommandArgs, strOpt, UsageError } from "../args";
import { printHits } from "../searchOutput";

export const summary = "Fast keyword search (FTS5 BM25)";

export const usage = `Usage: kura search "クエリ" [--bucket b] [--tag t] [--all] [--limit 20] [--json]

Options:
  --all     すべての語を含むドキュメントのみ（AND 検索）
  --tag t   タグで絞り込み（子孫タグを含む）`;

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    tag: { type: "string" },
    all: { type: "boolean", default: false },
    limit: { type: "string" },
  });
  const query = parsed.positionals.join(" ").trim();
  if (query === "") throw new UsageError("search query is required");
  loadConfig();
  const { db, tokenizer } = getDb();
  const hits = keywordSearch(db, tokenizer, query, {
    bucket: strOpt(parsed, "bucket"),
    tag: strOpt(parsed, "tag"),
    all: boolOpt(parsed, "all"),
    limit: intOpt(parsed, "limit") ?? 20,
  });
  printHits(hits, boolOpt(parsed, "json"));
  return EXIT.OK;
}
