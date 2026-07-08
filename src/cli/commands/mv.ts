import { getDb } from "../../core/db";
import { renameDocument, resolveDoc } from "../../core/documents";
import { EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Rename a document (relinks [[references]])";

export const usage = `Usage: kura mv <doc> <new-title> [--bucket b]

Renames a document and rewrites [[old title]] links in referring documents.

Options:
  --bucket <name>   Resolve title within this bucket`;

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, { bucket: { type: "string" } });
  const [spec, newTitle] = parsed.positionals;
  if (!spec || newTitle === undefined) throw new UsageError("mv requires <doc> <new-title>");

  const { db } = getDb();
  const doc = resolveDoc(db, spec, strOpt(parsed, "bucket"));
  const { record, relinked } = renameDocument(db, doc.id, newTitle);
  console.log(
    `renamed #${record.key}  ${doc.title} -> ${record.title}  (relinked ${relinked} documents)`,
  );
  return EXIT.OK;
}
