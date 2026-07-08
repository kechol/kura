import { getDb } from "../../core/db";
import { getDocumentByKey, resolveDoc, touchAccess } from "../../core/documents";
import { boolOpt, EXIT, parseCommandArgs, strOpt, UsageError } from "../args";
import { isColorEnabled, renderMarkdown } from "../render";

export const summary = "Show a document";

export const usage = `Usage: kura get <doc> [--pretty|--raw] [--json] [--lines A:B] [--bucket b]

<doc> is a doc key (#a1b2c3d4 or a1b2c3d4) or a title unique within a bucket.

Options:
  --pretty          ANSI-rendered Markdown (default when stdout is a TTY)
  --raw             Body only (default when piped)
  --json            Full document as JSON
  --lines <A:B>     1-based inclusive line range ('50:' and ':100' allowed)
  --bucket <name>   Resolve title within this bucket`;

/** --lines A:B（1 始まり・両端含む）で本文を行スライスする */
function sliceLines(content: string, range: string | undefined): string {
  if (range === undefined) return content;
  const m = range.match(/^(\d*):(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) {
    throw new UsageError(`--lines must be A:B (1-based, inclusive), got: ${range}`);
  }
  const lines = content.split(/\r?\n/);
  const start = m[1] === "" ? 1 : Number.parseInt(m[1]!, 10);
  const end = m[2] === "" ? lines.length : Number.parseInt(m[2]!, 10);
  if (start < 1 || end < start) throw new UsageError(`invalid --lines range: ${range}`);
  return lines.slice(start - 1, end).join("\n");
}

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, {
    pretty: { type: "boolean", default: false },
    raw: { type: "boolean", default: false },
    lines: { type: "string" },
    bucket: { type: "string" },
  });
  const spec = parsed.positionals[0];
  if (!spec) throw new UsageError("get requires <doc>");
  const pretty = boolOpt(parsed, "pretty");
  const raw = boolOpt(parsed, "raw");
  if (pretty && raw) throw new UsageError("--pretty and --raw are mutually exclusive");

  const { db } = getDb();
  const resolved = resolveDoc(db, spec, strOpt(parsed, "bucket"));
  touchAccess(db, resolved.id);
  // touch 後の access_count / last_accessed_at を出力に反映する
  const doc = getDocumentByKey(db, resolved.key) ?? resolved;
  const content = sliceLines(doc.content, strOpt(parsed, "lines"));

  if (boolOpt(parsed, "json")) {
    const out = {
      key: doc.key,
      title: doc.title,
      bucket: doc.bucket,
      tags: doc.tags,
      content,
      content_type: doc.contentType,
      source_url: doc.sourceUrl,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
      last_accessed_at: doc.lastAccessedAt,
      access_count: doc.accessCount,
    };
    console.log(JSON.stringify(out, null, 2));
    return EXIT.OK;
  }

  const usePretty = pretty || (!raw && process.stdout.isTTY === true);
  if (!usePretty) {
    console.log(content);
    return EXIT.OK;
  }

  const meta = [`#${doc.key}`, doc.bucket, doc.tags.join(", ")].filter((s) => s !== "").join(" · ");
  const md = `# ${doc.title}\n\n${meta}\n\n${content}`;
  console.log(renderMarkdown(md, { color: isColorEnabled() }));
  return EXIT.OK;
}
