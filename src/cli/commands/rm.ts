import { getDb } from "../../core/db";
import { deleteDocument, resolveDoc } from "../../core/documents";
import { boolOpt, EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Delete a document";

export const usage = `Usage: kura rm <doc> [--force] [--bucket b]

Options:
  --force           Skip the confirmation prompt (required when not a TTY)
  --bucket <name>   Resolve title within this bucket`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    force: { type: "boolean", short: "f", default: false },
    bucket: { type: "string" },
  });
  const spec = parsed.positionals[0];
  if (!spec) throw new UsageError("rm requires <doc>");

  const { db } = getDb();
  const doc = resolveDoc(db, spec, strOpt(parsed, "bucket"));

  if (!boolOpt(parsed, "force")) {
    if (!(process.stdout.isTTY === true && process.stdin.isTTY === true)) {
      throw new UsageError("refusing to delete without confirmation; use --force");
    }
    console.write(`delete #${doc.key}  ${doc.title}? [y/N] `);
    let answer = "";
    for await (const line of console) {
      answer = line;
      break;
    }
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log("aborted");
      return EXIT.OK;
    }
  }

  deleteDocument(db, doc.id);
  console.log(`deleted #${doc.key}  ${doc.title}`);
  return EXIT.OK;
}
