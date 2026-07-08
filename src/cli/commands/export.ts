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
  --dir <path>     Output directory (required). Files go to <dir>/<bucket>/<title>.md`;

const INVALID_CHARS = new Set(["/", "\\", ":", "*", "?", '"', "<", ">", "|"]);

/** タイトル → ファイル名: FS で使えない文字・制御文字を - に置換して trim */
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
    const bucketDir = join(dir, doc.bucket);
    mkdirSync(bucketDir, { recursive: true });

    let name = sanitizeFilename(doc.title);
    if (name === "") name = doc.key;
    if (used.has(join(doc.bucket, name).toLowerCase())) name = `${name}-${doc.key}`;
    used.add(join(doc.bucket, name).toLowerCase());

    const fm = serializeFrontmatter({
      kura_key: doc.key,
      title: doc.title,
      bucket: doc.bucket,
      tags: doc.tags,
      source_url: doc.sourceUrl,
      content_type: doc.contentType,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    const content = doc.content.endsWith("\n") ? doc.content : `${doc.content}\n`;
    writeFileSync(join(bucketDir, `${name}.md`), `${fm}\n\n${content}`);
  }

  if (boolOpt(parsed, "json")) {
    console.log(JSON.stringify({ exported: docs.length, dir }));
  } else {
    console.log(`exported ${docs.length} documents to ${dir}`);
  }
  return EXIT.OK;
}
