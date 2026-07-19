import { requireBucket } from "../../core/buckets";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { moveDocumentsByPrefix, resolveDoc, updateDocument } from "../../core/documents";
import { joinDocPath } from "../../core/wiki";
import { boolOpt, EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Rename or move a document (relinks [[references]])";

export const usage = `Usage: kura mv <doc> [<new-title>] [--path <new-path>] [--bucket b]
       kura mv --prefix <old-prefix> <new-prefix> [--bucket b]

Renames and/or moves a document and rewrites [[old title]] / [[old/full/path]]
links in referring documents. --prefix moves every document under a path
prefix at once (a destination conflict aborts the whole move).

Options:
  --path <path>     Move the document to this path ('' for the bucket root)
  --prefix          Treat the positionals as <old-prefix> <new-prefix>
  --bucket <name>   Resolve within this bucket (default: general.default_bucket)`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    path: { type: "string" },
    prefix: { type: "boolean", default: false },
  });
  const { db } = getDb();

  if (boolOpt(parsed, "prefix")) {
    const [oldPrefix, newPrefix] = parsed.positionals;
    if (oldPrefix === undefined || newPrefix === undefined) {
      throw new UsageError("mv --prefix requires <old-prefix> <new-prefix>");
    }
    const bucketName = strOpt(parsed, "bucket") ?? loadConfig().general.default_bucket;
    const bucket = requireBucket(db, bucketName);
    const { moved, relinked } = moveDocumentsByPrefix(db, bucket.id, oldPrefix, newPrefix);
    for (const m of moved) console.log(`moved #${m.key}  ${m.from} -> ${m.to}`);
    console.log(`${moved.length} documents moved (relinked ${relinked} documents)`);
    return EXIT.OK;
  }

  const [spec, newTitle] = parsed.positionals;
  const newPath = strOpt(parsed, "path");
  if (!spec || (newTitle === undefined && newPath === undefined)) {
    throw new UsageError("mv requires <doc> and <new-title> and/or --path");
  }

  const doc = resolveDoc(db, spec, strOpt(parsed, "bucket"));
  const { record, relinked } = updateDocument(db, doc.id, { title: newTitle, path: newPath });
  const verb = newPath === undefined ? "renamed" : "moved";
  console.log(
    `${verb} #${record.key}  ${joinDocPath(doc.path, doc.title)} -> ${joinDocPath(record.path, record.title)}  (relinked ${relinked} documents)`,
  );
  return EXIT.OK;
}
