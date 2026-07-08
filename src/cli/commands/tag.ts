import { suggestTagsForText } from "../../core/clip/format";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { type DocumentRecord, resolveDoc } from "../../core/documents";
import { auditTags, untaggedDocuments } from "../../core/gardening";
import { requireProvider, resolveProvider } from "../../core/llm/provider";
import {
  addTagsToDoc,
  buildTagTree,
  gcTags,
  listTags,
  removeTagsFromDoc,
  renameTag,
  type TagTreeNode,
} from "../../core/tags";
import { boolOpt, EXIT, type Parsed, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Manage tags";

export const usage = `Usage:
  kura tag ls [--tree] [--json]
  kura tag add <doc> <tag>... [--bucket b]
  kura tag rm <doc> <tag>... [--bucket b]
  kura tag mv <old-path> <new-path>
  kura tag gc
  kura tag suggest [--doc d] [--untagged] [--apply] [--bucket b]
  kura tag audit [--apply]

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

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    tree: { type: "boolean", default: false },
    bucket: { type: "string" },
    doc: { type: "string" },
    untagged: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
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
    case "suggest":
      return runSuggest(parsed);
    case "audit":
      return runAudit(parsed);
    default:
      throw new UsageError(sub ? `unknown subcommand: ${sub}` : "missing subcommand");
  }
}

/** y/N confirmation on a TTY. Returns the default when not a TTY */
async function confirm(prompt: string, nonTtyDefault: boolean): Promise<boolean> {
  if (process.stdout.isTTY !== true || process.stdin.isTTY !== true) return nonTtyDefault;
  process.stdout.write(`${prompt} [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d)));
  });
  return /^y(es)?$/i.test(answer.trim());
}

/** kura tag suggest: LLM tag suggestions (reusing the existing tag taxonomy first, SPEC §10.3) */
async function runSuggest(parsed: Parsed): Promise<number> {
  const docSpec = strOpt(parsed, "doc");
  if (!docSpec && !boolOpt(parsed, "untagged")) {
    throw new UsageError("tag suggest requires --doc <doc> or --untagged");
  }
  const config = loadConfig();
  const { db } = getDb();
  const provider = await requireProvider(config);
  const apply = boolOpt(parsed, "apply");
  const bucket = strOpt(parsed, "bucket");

  let targets: Array<Pick<DocumentRecord, "id" | "key" | "title" | "content">>;
  if (docSpec) {
    targets = [resolveDoc(db, docSpec, bucket)];
  } else {
    targets = untaggedDocuments(db, bucket);
  }
  if (targets.length === 0) {
    console.log("no target documents");
    return EXIT.OK;
  }

  const existing = listTags(db).map((t) => t.path);
  let applied = 0;
  for (const doc of targets) {
    const suggested = await suggestTagsForText(
      db,
      provider,
      config,
      `${doc.title}\n\n${doc.content}`,
      existing,
    );
    if (suggested.length === 0) {
      console.log(`#${doc.key}  ${doc.title}: no suggestions`);
      continue;
    }
    console.log(`#${doc.key}  ${doc.title}: ${suggested.join(", ")}`);
    if (apply && (await confirm("  apply?", true))) {
      const added = addTagsToDoc(db, doc.id, suggested, "auto");
      applied += added.length;
      if (added.length > 0) console.log(`  applied: ${added.join(", ")}`);
    }
  }
  if (apply) console.log(`${applied} tags applied`);
  else console.log("(use --apply to apply)");
  return EXIT.OK;
}

/** kura tag audit: merge proposals for similar tags and warnings about oversized tags (SPEC §10.3) */
async function runAudit(parsed: Parsed): Promise<number> {
  const config = loadConfig();
  const { db } = getDb();
  const provider = await resolveProvider(config);
  if (!provider) {
    console.error("warning: no LLM provider available; auditing with edit distance only");
  }
  const result = await auditTags(db, provider, config);

  if (result.merges.length === 0 && result.oversized.length === 0) {
    console.log("no issues found");
    return EXIT.OK;
  }

  let merged = 0;
  for (const m of result.merges) {
    console.log(`merge: ${m.from} -> ${m.to}  (${m.reason})`);
    if (boolOpt(parsed, "apply") && (await confirm("  merge?", true))) {
      renameTag(db, m.from, m.to);
      merged++;
      console.log("  merged");
    }
  }
  for (const o of result.oversized) {
    console.log(
      `oversized: ${o.path} is attached to ${(o.share * 100).toFixed(0)}% of documents (${o.count}); consider splitting it`,
    );
  }
  if (boolOpt(parsed, "apply")) console.log(`${merged} merges applied`);
  else if (result.merges.length > 0) console.log("(use --apply to merge interactively)");
  return EXIT.OK;
}
