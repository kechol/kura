import { getDb } from "../../core/db";
import { resolveDoc } from "../../core/documents";
import {
  addTagsToDoc,
  buildTagTree,
  gcTags,
  listTags,
  removeTagsFromDoc,
  renameTag,
  type TagTreeNode,
} from "../../core/tags";
import { boolOpt, EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Manage tags";

export const usage = `Usage:
  kura tag ls [--tree] [--json]
  kura tag add <doc> <tag>... [--bucket b]
  kura tag rm <doc> <tag>... [--bucket b]
  kura tag mv <old-path> <new-path>
  kura tag gc

Examples:
  kura tag ls --tree
  kura tag add "SQLite の WAL モード" 技術/データベース
  kura tag mv 旧分類 技術`;

function printTree(nodes: TagTreeNode[], depth: number): void {
  for (const node of nodes) {
    console.log(`${"  ".repeat(depth)}${node.segment} (${node.total})`);
    printTree(node.children, depth + 1);
  }
}

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, {
    tree: { type: "boolean", default: false },
    bucket: { type: "string" },
  });
  const [sub, ...rest] = parsed.positionals;
  const json = boolOpt(parsed, "json");

  switch (sub) {
    case "ls": {
      const { db } = getDb();
      const entries = listTags(db);
      if (boolOpt(parsed, "tree")) {
        const tree = buildTagTree(entries);
        if (json) {
          console.log(JSON.stringify(tree));
        } else {
          printTree(tree, 0);
        }
      } else if (json) {
        console.log(JSON.stringify(entries));
      } else {
        for (const e of entries) console.log(`${e.path}  ${e.count}`);
      }
      return EXIT.OK;
    }
    case "add": {
      const [spec, ...tags] = rest;
      if (!spec || tags.length === 0) throw new UsageError("tag add requires <doc> <tag>...");
      const { db } = getDb();
      const doc = resolveDoc(db, spec, strOpt(parsed, "bucket"));
      const added = addTagsToDoc(db, doc.id, tags, "manual");
      console.log(added.length > 0 ? `added: ${added.join(", ")}` : "no tags added");
      return EXIT.OK;
    }
    case "rm": {
      const [spec, ...tags] = rest;
      if (!spec || tags.length === 0) throw new UsageError("tag rm requires <doc> <tag>...");
      const { db } = getDb();
      const doc = resolveDoc(db, spec, strOpt(parsed, "bucket"));
      const removed = removeTagsFromDoc(db, doc.id, tags);
      console.log(`removed ${removed} tags`);
      return EXIT.OK;
    }
    case "mv": {
      const [oldPath, newPath] = rest;
      if (!oldPath || !newPath) throw new UsageError("tag mv requires <old-path> <new-path>");
      const { db } = getDb();
      const result = renameTag(db, oldPath, newPath);
      const suffix = result.merged ? " (merged into existing)" : "";
      console.log(`moved ${result.moved.length} tags${suffix}`);
      return EXIT.OK;
    }
    case "gc": {
      const { db } = getDb();
      const removed = gcTags(db);
      console.log(
        removed.length > 0
          ? `removed ${removed.length} orphan tags: ${removed.join(", ")}`
          : "no orphan tags",
      );
      return EXIT.OK;
    }
    default:
      throw new UsageError(sub ? `unknown subcommand: ${sub}` : "missing subcommand");
  }
}
