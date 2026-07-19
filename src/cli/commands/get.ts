import { getDb } from "../../core/db";
import { getDocumentByKey, resolveDoc, touchAccess } from "../../core/documents";
import { toSqliteDatetime } from "../../core/frontmatter";
import { stateAsOf } from "../../core/revisions";
import { boolOpt, EXIT, NotFoundError, parseCommandArgs, strOpt, UsageError } from "../args";
import { isColorEnabled, renderMarkdown } from "../render";

export const summary = "Show a document";

export const usage = `Usage: kura get <doc> [--pretty|--raw] [--json] [--lines A:B] [--bucket b] [--as-of T]

<doc> is a doc key (#a1b2c3d4 or a1b2c3d4), a full path (clips/Title), a
title unique within a bucket, or a unique alias.

Options:
  --pretty          ANSI-rendered Markdown (default when stdout is a TTY)
  --raw             Body only (default when piped)
  --json            Full document as JSON
  --lines <A:B>     1-based inclusive line range ('50:' and ':100' allowed)
  --bucket <name>   Resolve title within this bucket
  --as-of <time>    Show the document as it was at that time (ISO 8601 or
                    'YYYY-MM-DD'; backed by revisions — see kura history).
                    Tags and aliases shown are always the current ones.`;

/** Slice the body by lines with --lines A:B (1-based, inclusive) */
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
    "as-of": { type: "string" },
  });
  const spec = parsed.positionals[0];
  if (!spec) throw new UsageError("get requires <doc>");
  const pretty = boolOpt(parsed, "pretty");
  const raw = boolOpt(parsed, "raw");
  if (pretty && raw) throw new UsageError("--pretty and --raw are mutually exclusive");

  const { db } = getDb();
  const resolved = resolveDoc(db, spec, strOpt(parsed, "bucket"));
  touchAccess(db, resolved.id);
  // Reflect access_count / last_accessed_at from after the touch in the output
  const doc = getDocumentByKey(db, resolved.key) ?? resolved;

  // --as-of: swap in the historical title / path / body (docs: cli-reference.md)
  let view = { title: doc.title, path: doc.path, content: doc.content };
  let asOf: string | null = null;
  let revisionId: number | null = null;
  const asOfRaw = strOpt(parsed, "as-of");
  if (asOfRaw !== undefined) {
    asOf = toSqliteDatetime(asOfRaw);
    if (asOf === null) throw new UsageError(`--as-of must be a date or datetime, got: ${asOfRaw}`);
    const state = stateAsOf(db, doc.id, asOf);
    if (state === null) {
      throw new NotFoundError(
        `no recorded state of #${doc.key} at ${asOf} (created later, or the snapshot was pruned)`,
      );
    }
    view = { title: state.title, path: state.path, content: state.content };
    revisionId = state.source === "revision" ? (state.revisionId ?? null) : null;
  }
  const content = sliceLines(view.content, strOpt(parsed, "lines"));

  if (boolOpt(parsed, "json")) {
    const out = {
      key: doc.key,
      path: view.path,
      title: view.title,
      bucket: doc.bucket,
      tags: doc.tags,
      aliases: doc.aliases,
      content,
      content_type: doc.contentType,
      source_url: doc.sourceUrl,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
      last_accessed_at: doc.lastAccessedAt,
      access_count: doc.accessCount,
      ...(asOf !== null ? { as_of: asOf, revision_id: revisionId } : {}),
    };
    console.log(JSON.stringify(out, null, 2));
    return EXIT.OK;
  }

  const usePretty = pretty || (!raw && process.stdout.isTTY === true);
  if (!usePretty) {
    console.log(content);
    return EXIT.OK;
  }

  const meta = [
    `#${doc.key}`,
    doc.bucket,
    view.path,
    doc.tags.join(", "),
    doc.aliases.length > 0 ? `aliases: ${doc.aliases.join(", ")}` : "",
    asOf !== null ? `as of ${asOf}${revisionId !== null ? ` (r${revisionId})` : ""}` : "",
  ]
    .filter((s) => s !== "")
    .join(" · ");
  const md = `# ${view.title}\n\n${meta}\n\n${content}`;
  console.log(renderMarkdown(md, { color: isColorEnabled() }));
  return EXIT.OK;
}
