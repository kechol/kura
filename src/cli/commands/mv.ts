import { requireBucket } from "../../core/buckets";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { moveDocumentsByPrefix, resolveDoc, updateDocument } from "../../core/documents";
import {
  listUnfiledDocuments,
  type PathSuggestion,
  suggestedPath,
  suggestPathForDocument,
} from "../../core/filing";
import { resolveProvider } from "../../core/llm/provider";
import { joinDocPath, normalizeDocPath } from "../../core/wiki";
import { boolOpt, EXIT, intOpt, type Parsed, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Rename or move a document (relinks [[references]])";

export const usage = `Usage: kura mv <doc> [<new-title>] [--path <new-path>] [--bucket b]
       kura mv --prefix <old-prefix> <new-prefix> [--bucket b]
       kura mv suggest [--bucket b] [--limit n] [--json] [--apply]

Renames and/or moves a document and rewrites [[old title]] / [[old/full/path]]
links in referring documents. --prefix moves every document under a path
prefix at once (a destination conflict aborts the whole move).

mv suggest proposes a path for each unfiled (bucket-root) document from
link / tag / keyword signals, plus semantic neighbors and an LLM pick when
a provider is reachable. Without --json / --apply it prompts per document
on a TTY and prints a dry run otherwise.

Options:
  --path <path>     Move the document to this path ('' for the bucket root)
  --prefix          Treat the positionals as <old-prefix> <new-prefix>
  --bucket <name>   Resolve within this bucket (default: general.default_bucket)
  --limit <n>       suggest: only consider the first n unfiled documents
  --apply           suggest: apply every suggestion without confirmation
  --json            suggest: print suggestions as JSON (never applies)`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    path: { type: "string" },
    prefix: { type: "boolean", default: false },
    apply: { type: "boolean", default: false },
    limit: { type: "string" },
  });
  const { db } = getDb();

  if (parsed.positionals[0] === "suggest") return runSuggest(parsed);

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

function printSuggestion(s: PathSuggestion, choice: string | null): void {
  console.log(`#${s.doc.key}  ${s.doc.title}`);
  if (choice === null) {
    console.log("  (no signals — skipped)");
    return;
  }
  if (s.llm) {
    const marker = s.llm.isNew ? " (new path)" : "";
    console.log(`  suggest: ${s.llm.path}${marker}${s.llm.reason ? `  — ${s.llm.reason}` : ""}`);
  } else {
    console.log(`  suggest: ${choice}`);
  }
  for (const c of s.candidates) {
    console.log(`  signal: ${c.path} (score ${c.score}) ${c.evidence.slice(0, 3).join("; ")}`);
  }
}

function ask(question: string): Promise<string> {
  process.stdout.write(question);
  return new Promise((resolve) => {
    process.stdin.once("data", (d) => resolve(String(d).trim()));
  });
}

/** kura mv suggest: interactive filing assistant for unfiled documents (docs: cli-reference.md) */
async function runSuggest(parsed: Parsed): Promise<number> {
  const { db, tokenizer } = getDb();
  const config = loadConfig();
  const bucketName = strOpt(parsed, "bucket") ?? config.general.default_bucket;
  requireBucket(db, bucketName);
  const jsonOut = boolOpt(parsed, "json");
  const apply = boolOpt(parsed, "apply");
  if (jsonOut && apply) throw new UsageError("--json and --apply are mutually exclusive");

  let docs = listUnfiledDocuments(db, bucketName);
  const limit = intOpt(parsed, "limit");
  if (limit !== undefined) docs = docs.slice(0, limit);
  if (docs.length === 0) {
    console.log(jsonOut ? "[]" : `no unfiled documents in bucket '${bucketName}'`);
    return EXIT.OK;
  }

  const provider = await resolveProvider(config);
  if (!provider) {
    console.error(
      "warning: no LLM provider available; suggesting from link/tag/keyword signals only",
    );
  }

  const interactive =
    !jsonOut && !apply && process.stdout.isTTY === true && process.stdin.isTTY === true;
  const jsonResults: unknown[] = [];
  let applied = 0;
  let skipped = 0;

  for (const doc of docs) {
    const suggestion = await suggestPathForDocument(db, tokenizer, config, provider, doc);
    for (const w of suggestion.warnings) console.error(`warning: ${w}`);
    const choice = suggestedPath(suggestion);

    if (jsonOut) {
      jsonResults.push({
        key: doc.key,
        title: doc.title,
        suggestion:
          choice === null
            ? null
            : {
                path: choice,
                source: suggestion.llm ? "llm" : "signals",
                ...(suggestion.llm?.reason ? { reason: suggestion.llm.reason } : {}),
              },
        candidates: suggestion.candidates,
      });
      continue;
    }

    printSuggestion(suggestion, choice);
    if (choice === null) {
      skipped++;
      continue;
    }
    if (apply) {
      updateDocument(db, doc.id, { path: choice });
      console.log(`  moved -> ${joinDocPath(choice, doc.title)}`);
      applied++;
      continue;
    }
    if (!interactive) continue;

    const answer = (await ask("  apply? [y=yes / e=edit path / n=skip / q=quit] ")).toLowerCase();
    if (answer === "q") break;
    if (answer === "y") {
      updateDocument(db, doc.id, { path: choice });
      console.log(`  moved -> ${joinDocPath(choice, doc.title)}`);
      applied++;
    } else if (answer === "e") {
      const edited = normalizeDocPath(await ask("  path: "));
      if (edited === "") {
        skipped++;
      } else {
        updateDocument(db, doc.id, { path: edited });
        console.log(`  moved -> ${joinDocPath(edited, doc.title)}`);
        applied++;
      }
    } else {
      skipped++;
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify(jsonResults, null, 2));
    return EXIT.OK;
  }
  console.log(`${applied} moved, ${skipped} skipped (of ${docs.length} unfiled)`);
  if (!apply && !interactive && applied === 0) {
    console.log("dry run — pass --apply to move, or run on a TTY to confirm per document");
  }
  return EXIT.OK;
}
