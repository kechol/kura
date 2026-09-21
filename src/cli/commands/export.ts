import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
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
  const trimmed = out.trim();
  return trimmed === "." || trimmed === ".." ? "-" : trimmed;
}

function ensureContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new UsageError(`refusing to export outside the output directory: ${candidate}`);
  }
}

/** Create an export directory without following document-controlled symlinks. */
function ensureExportDirectory(root: string, segments: string[]): string {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    ensureContained(root, current);
    try {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new UsageError(`unsafe export path component: ${current}`);
      }
    } catch (e) {
      if (e && typeof e === "object" && "code" in e && e.code === "ENOENT") {
        mkdirSync(current);
        continue;
      }
      throw e;
    }
  }
  return current;
}

/** Validate the opened inode before truncation; links must not modify another path. */
function writeExportFile(path: string, content: string): void {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    0o666,
  );
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) {
      throw new UsageError(`unsafe export file: ${path}`);
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
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
  mkdirSync(dir, { recursive: true });
  const exportRoot = realpathSync(dir);

  const used = new Set<string>();
  for (const doc of docs) {
    // Document path segments become real subdirectories; the title stays a
    // single file name (a literal '/' in a title is sanitized, not nested)
    const segments = doc.path === "" ? [] : doc.path.split("/").map(sanitizeFilename);
    const outDir = ensureExportDirectory(exportRoot, [sanitizeFilename(doc.bucket), ...segments]);

    let name = sanitizeFilename(doc.title);
    if (name === "") name = doc.key;
    const usedKey = (n: string) => join(outDir, `${n}.md`).normalize("NFD").toLowerCase();
    const base = name;
    let suffix = 0;
    while (used.has(usedKey(name))) {
      name = `${base}-${doc.key}${suffix === 0 ? "" : `-${suffix}`}`;
      suffix++;
    }
    used.add(usedKey(name));

    const fm = serializeFrontmatter({
      kura_key: doc.key,
      title: doc.title,
      bucket: doc.bucket,
      path: doc.path,
      tags: doc.tags,
      aliases: doc.aliases,
      favorite: doc.favorite,
      source_url: doc.sourceUrl,
      content_type: doc.contentType,
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
    });
    const content = doc.content.endsWith("\n") ? doc.content : `${doc.content}\n`;
    const outputPath = join(outDir, `${name}.md`);
    ensureContained(exportRoot, outputPath);
    writeExportFile(outputPath, `${fm}\n\n${content}`);
  }

  if (boolOpt(parsed, "json")) {
    console.log(JSON.stringify({ exported: docs.length, dir }));
  } else {
    console.log(`exported ${docs.length} documents to ${dir}`);
  }
  return EXIT.OK;
}
