import { getDb } from "../../core/db";
import { resolveDoc } from "../../core/documents";
import { backlinks, outlinks, type RelatedDoc, twoHopLinks } from "../../core/links";
import { boolOpt, EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Show links and backlinks";

export const usage = `Usage:
  kura link ls <doc> [--bucket b] [--json]

Examples:
  kura link ls "データベース設計"`;

function docLine(doc: RelatedDoc): string {
  return `#${doc.key} ${doc.title} (${doc.bucket})`;
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
  });
  const [sub, ...rest] = parsed.positionals;
  const json = boolOpt(parsed, "json");
  const bucketName = strOpt(parsed, "bucket");

  switch (sub) {
    case "ls": {
      const spec = rest[0];
      if (!spec) throw new UsageError("link ls requires <doc>");
      const { db } = getDb();
      const doc = resolveDoc(db, spec, bucketName);
      const outs = outlinks(db, doc.id);
      const backs = backlinks(db, doc.id);
      const hops = twoHopLinks(db, doc.id);

      if (json) {
        console.log(
          JSON.stringify({
            outlinks: outs.map((o) => ({
              target_title: o.targetTitle,
              key: o.target?.key ?? null,
              title: o.target?.title ?? null,
              bucket: o.target?.bucket ?? null,
            })),
            backlinks: backs,
            twoHop: hops,
          }),
        );
        return EXIT.OK;
      }

      console.log("outlinks:");
      if (outs.length === 0) console.log("  (none)");
      for (const o of outs) {
        const dest = o.target ? `#${o.target.key} (${o.target.bucket})` : "(unresolved)";
        console.log(`  [[${o.targetTitle}]] -> ${dest}`);
      }
      console.log("backlinks:");
      if (backs.length === 0) console.log("  (none)");
      for (const b of backs) console.log(`  ${docLine(b)}`);
      if (hops.length === 0) {
        console.log("2-hop:");
        console.log("  (none)");
      } else {
        for (const group of hops) {
          console.log(`2-hop (via ${group.via.title}):`);
          for (const d of group.docs) console.log(`  ${docLine(d)}`);
        }
      }
      return EXIT.OK;
    }
    default:
      throw new UsageError(sub ? `unknown subcommand: ${sub}` : "missing subcommand");
  }
}
