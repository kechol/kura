import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../../core/db";
import { listDocuments } from "../../core/documents";
import { serializeFrontmatter } from "../../core/frontmatter";
import { boolOpt, EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Export documents as Markdown with frontmatter";

export const usage = `Usage: kura export [--bucket <name>] [--tag <path>] --dir <path>

Options:
  --bucket <name>  Export only the given bucket
  --tag <path>     Export only documents with the tag (descendants included)
  --dir <path>     Output directory (required). Files go to <dir>/<bucket>/<path...>/<title>.md`;

const INVALID_CHARS = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

/** Title → file name: replace FS-invalid and control characters with - and trim */
function sanitizeFilename(title: string): string {
  let out = "";
  for (const ch of title) {
    const code = ch.codePointAt(0) ?? 0;
    out += INVALID_CHARS.has(ch) || code < 0x20 || code === 0x7f ? "-" : ch;
  }
  return out.trim();
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    tag: { type: "string" },
    dir: { type: "string" },
  });
  const dir = strOpt(parsed, "dir");
  if (!dir) throw new UsageError("--dir <path> is required");

  const { db } = getDb();
  const docs = listDocuments(db, { bucket: strOpt(parsed, "bucket"), tag: strOpt(parsed, "tag") });

  const used = new Set<string>();
  for (const doc of docs) {
    // Document path segments become real subdirectories; the title stays a
    // single file name (a literal '/' in a title is sanitized, not nested)
    const segments = doc.path === "" ? [] : doc.path.split("/").map(sanitizeFilename);
    const outDir = join(dir, doc.bucket, ...segments);
    mkdirSync(outDir, { recursive: true });

    let name = sanitizeFilename(doc.title);
    if (name === "") name = doc.key;
    const usedKey = (n: string) => [doc.bucket, ...segments, n].join("/").toLowerCase();
    if (used.has(usedKey(name))) name = `${name}-${doc.key}`;
    used.add(usedKey(name));

    const fm = serializeFrontmatter({
      kura_key: doc.key,
      title: doc.title,
      bucket: doc.bucket,
      path: doc.path,
      tags: doc.tags,
      favorite: doc.favorite,
      source_url: doc.sourceUrl,
      content_type: doc.contentType,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    const content = doc.content.endsWith("\n") ? doc.content : `${doc.content}\n`;
    writeFileSync(join(outDir, `${name}.md`), `${fm}\n\n${content}`);
  }

  if (boolOpt(parsed, "json")) {
    console.log(JSON.stringify({ exported: docs.length, dir }));
  } else {
    console.log(`exported ${docs.length} documents to ${dir}`);
  }
  return EXIT.OK;
}
