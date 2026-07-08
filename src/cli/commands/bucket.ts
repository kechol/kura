import { createBucket, deleteBucket, listBuckets, renameBucket } from "../../core/buckets";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { deleteDocument, listDocuments } from "../../core/documents";
import { boolOpt, EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Manage buckets";

export const usage = `Usage:
  kura bucket ls [--json]
  kura bucket add <name> [--desc <text>]
  kura bucket rm <name> [--force]
  kura bucket mv <old> <new>

Options:
  --desc <text>   Description for the new bucket
  --force         Delete a non-empty bucket together with its documents`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    desc: { type: "string" },
    force: { type: "boolean", default: false },
  });
  const [sub = "ls", ...rest] = parsed.positionals;
  const { db } = getDb();

  switch (sub) {
    case "ls": {
      const buckets = listBuckets(db);
      if (boolOpt(parsed, "json")) {
        const out = buckets.map((b) => ({
          name: b.name,
          description: b.description,
          documents: b.documents,
          created_at: b.createdAt,
        }));
        console.log(JSON.stringify(out, null, 2));
      } else {
        for (const b of buckets) {
          console.log(`${b.name}  ${b.documents} documents  ${b.description ?? ""}`.trimEnd());
        }
      }
      return EXIT.OK;
    }
    case "add": {
      const name = rest[0];
      if (!name) throw new UsageError("bucket add requires <name>");
      createBucket(db, name, strOpt(parsed, "desc"));
      console.log(`created bucket ${name}`);
      return EXIT.OK;
    }
    case "rm": {
      const name = rest[0];
      if (!name) throw new UsageError("bucket rm requires <name>");
      if (name === loadConfig().general.default_bucket) {
        throw new UsageError("cannot delete the default bucket");
      }
      let removed = 0;
      if (boolOpt(parsed, "force")) {
        for (const doc of listDocuments(db, { bucket: name })) {
          deleteDocument(db, doc.id);
          removed++;
        }
      }
      // Still non-empty (no --force): let the ConflictError propagate as-is
      deleteBucket(db, name);
      console.log(`deleted bucket ${name} (${removed} documents)`);
      return EXIT.OK;
    }
    case "mv": {
      const [oldName, newName] = rest;
      if (!oldName || !newName) throw new UsageError("bucket mv requires <old> <new>");
      renameBucket(db, oldName, newName);
      console.log(`renamed bucket ${oldName} -> ${newName}`);
      return EXIT.OK;
    }
    default:
      throw new UsageError(`unknown subcommand: ${sub}`);
  }
}
