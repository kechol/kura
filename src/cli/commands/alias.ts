import { addAliasesToDoc, docAliases, removeAliasesFromDoc } from "../../core/aliases";
import { getDb } from "../../core/db";
import { resolveDoc } from "../../core/documents";
import { boolOpt, EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Manage document aliases (alternate titles)";

export const usage = `Usage:
  kura alias ls <doc> [--bucket b] [--json]
  kura alias add <doc> <alias...> [--bucket b] [--json]
  kura alias rm <doc> <alias...> [--bucket b] [--json]

Aliases are alternate titles: [[alias]] links resolve to the document and
keyword search matches them. Useful for orthographic variants
(サーバー/サーバ) and abbreviations.

Examples:
  kura alias add "データベース設計" DB設計
  kura alias ls "データベース設計"`;

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
  });
  const [sub, spec, ...aliases] = parsed.positionals;
  const json = boolOpt(parsed, "json");
  const bucketName = strOpt(parsed, "bucket");
  if (sub !== "ls" && sub !== "add" && sub !== "rm") {
    throw new UsageError(sub ? `unknown subcommand: ${sub}` : "missing subcommand");
  }
  if (!spec) throw new UsageError(`alias ${sub} requires <doc>`);

  const { db } = getDb();
  const doc = resolveDoc(db, spec, bucketName);

  switch (sub) {
    case "ls": {
      const list = docAliases(db, doc.id);
      if (json) {
        console.log(JSON.stringify({ key: doc.key, title: doc.title, aliases: list }));
      } else if (list.length === 0) {
        console.log(`no aliases for #${doc.key} ${doc.title}`);
      } else {
        for (const a of list) console.log(a);
      }
      return EXIT.OK;
    }
    case "add": {
      if (aliases.length === 0) throw new UsageError("alias add requires at least one <alias>");
      const added = addAliasesToDoc(db, doc.id, aliases);
      if (json) {
        console.log(JSON.stringify({ key: doc.key, added, aliases: docAliases(db, doc.id) }));
      } else {
        console.log(`added ${added.length} alias(es) to #${doc.key} ${doc.title}`);
      }
      return EXIT.OK;
    }
    case "rm": {
      if (aliases.length === 0) throw new UsageError("alias rm requires at least one <alias>");
      const removed = removeAliasesFromDoc(db, doc.id, aliases);
      if (json) {
        console.log(JSON.stringify({ key: doc.key, removed, aliases: docAliases(db, doc.id) }));
      } else {
        console.log(`removed ${removed} alias(es) from #${doc.key} ${doc.title}`);
      }
      return EXIT.OK;
    }
  }
}
