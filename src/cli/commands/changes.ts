import { type ChangeEntry, changesSince, parseSince } from "../../core/changes";
import { getDb } from "../../core/db";
import { joinDocPath } from "../../core/wiki";
import { boolOpt, EXIT, intOpt, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "List documents created or updated since a point in time";

export const usage = `Usage: kura changes --since <time> [--bucket b] [--limit 50] [--json]

<time> is relative (30m / 24h / 7d / 2w) or a date/datetime (ISO 8601,
YYYY-MM-DD). Renames and moves are detected against the revision history;
deletions are not tracked.

Examples:
  kura changes --since 7d
  kura changes --since 2026-07-01 --bucket main --json`;

function detail(c: ChangeEntry): string {
  if (c.kind === "created") return "";
  const parts: string[] = [];
  if (c.contentChanged) parts.push("content");
  if (c.renamed) parts.push(`renamed from ${c.previousTitle}`);
  if (c.moved) parts.push(`moved from ${c.previousPath === "" ? "(root)" : c.previousPath}`);
  return parts.length > 0 ? `  (${parts.join(", ")})` : "";
}

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, {
    since: { type: "string" },
    bucket: { type: "string" },
    limit: { type: "string" },
  });
  const sinceRaw = strOpt(parsed, "since");
  if (!sinceRaw) throw new UsageError("--since <time> is required (e.g. --since 7d)");
  const since = parseSince(sinceRaw);
  if (since === null) {
    throw new UsageError(`--since must be relative (7d) or a date/datetime, got: ${sinceRaw}`);
  }

  const { db } = getDb();
  const changes = changesSince(db, since, {
    bucket: strOpt(parsed, "bucket"),
    limit: intOpt(parsed, "limit"),
  });

  if (boolOpt(parsed, "json")) {
    console.log(
      JSON.stringify(
        {
          since,
          changes: changes.map((c) => ({
            key: c.key,
            bucket: c.bucket,
            path: c.path,
            title: c.title,
            kind: c.kind,
            created_at: c.createdAt,
            updated_at: c.updatedAt,
            content_changed: c.contentChanged,
            renamed: c.renamed,
            moved: c.moved,
            previous_title: c.previousTitle,
            previous_path: c.previousPath,
          })),
        },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }

  if (changes.length === 0) {
    console.log(`no changes since ${since}`);
    return EXIT.OK;
  }
  for (const c of changes) {
    console.log(
      `${c.kind.padEnd(7)}  #${c.key}  ${joinDocPath(c.path, c.title)}  [${c.bucket}]  ${c.updatedAt}${detail(c)}`,
    );
  }
  return EXIT.OK;
}
