import { getDb } from "../../core/db";
import { resolveDoc, updateDocument } from "../../core/documents";
import { getRevision, listRevisions, type RevisionMeta } from "../../core/revisions";
import { joinDocPath } from "../../core/wiki";
import { boolOpt, EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Show and restore document revisions";

export const usage = `Usage:
  kura history <doc> [--bucket b] [--json]
  kura history show <doc> <rN> [--bucket b] [--json]
  kura history restore <doc> <rN> [--bucket b] [--json]

Every content, title, or path change snapshots the state being replaced
(rapid saves collapse into one revision per editing burst). restore replaces
the current body with the revision's content — title and path stay as they
are — and the replaced state is snapshotted first, so a restore is itself
undoable. Past states are also addressable with 'kura get --as-of'.

Examples:
  kura history "データベース設計"
  kura history show "データベース設計" r12
  kura history restore "データベース設計" r12`;

function parseRevisionId(raw: string): number {
  const m = raw.match(/^r?(\d+)$/);
  if (!m) throw new UsageError(`invalid revision id: ${raw} (expected e.g. r12)`);
  return Number.parseInt(m[1]!, 10);
}

function revisionJson(r: RevisionMeta): Record<string, unknown> {
  return {
    id: r.id,
    title: r.title,
    path: r.path,
    content_hash: r.contentHash,
    saved_at: r.savedAt,
    created_at: r.createdAt,
    bytes: r.bytes,
  };
}

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
  });
  const json = boolOpt(parsed, "json");
  const bucketName = strOpt(parsed, "bucket");
  const [first, ...rest] = parsed.positionals;
  if (!first) throw new UsageError("history requires <doc>");

  const { db } = getDb();

  if (first === "show" || first === "restore") {
    const [spec, revRaw] = rest;
    if (!spec || !revRaw) throw new UsageError(`history ${first} requires <doc> <rN>`);
    const doc = resolveDoc(db, spec, bucketName);
    const revision = getRevision(db, doc.id, parseRevisionId(revRaw));

    if (first === "show") {
      if (json) {
        console.log(
          JSON.stringify(
            { key: doc.key, ...revisionJson(revision), content: revision.content },
            null,
            2,
          ),
        );
      } else {
        console.log(revision.content);
      }
      return EXIT.OK;
    }

    // restore: content only — title/path restores could collide with other documents
    const { record } = updateDocument(db, doc.id, { content: revision.content });
    if (json) {
      console.log(JSON.stringify({ key: record.key, restored: revision.id }));
    } else {
      console.log(`restored #${record.key} ${record.title} to r${revision.id} (content only)`);
    }
    return EXIT.OK;
  }

  const doc = resolveDoc(db, first, bucketName);
  const revisions = listRevisions(db, doc.id);
  if (json) {
    console.log(
      JSON.stringify(
        { key: doc.key, title: doc.title, revisions: revisions.map(revisionJson) },
        null,
        2,
      ),
    );
    return EXIT.OK;
  }
  if (revisions.length === 0) {
    console.log(`no revisions for #${doc.key} ${doc.title}`);
    return EXIT.OK;
  }
  for (const r of revisions) {
    console.log(
      `r${r.id}  ${r.savedAt}  ${joinDocPath(r.path, r.title)}  ${r.bytes}B  ${r.contentHash.slice(0, 8)}`,
    );
  }
  return EXIT.OK;
}
