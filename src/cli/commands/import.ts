import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative, sep } from "node:path";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { importDocument } from "../../core/documents";
import { parseFrontmatter } from "../../core/frontmatter";
import {
  boolOpt,
  ConflictError,
  EXIT,
  NotFoundError,
  parseCommandArgs,
  strOpt,
  UsageError,
} from "../args";

export const summary = "Import Markdown files (frontmatter round-trip)";

export const usage = `Usage: kura import <dir|file>... [--bucket <name>]

Options:
  --bucket <name>  Import into this bucket (overrides frontmatter)

Directories are scanned recursively for *.md / *.markdown files; a file's
subdirectory becomes its document path unless the frontmatter has one.
Files whose frontmatter has a known kura_key update the existing document.`;

const MD_EXTS = new Set([".md", ".markdown"]);

interface FoundFile {
  path: string;
  /** Directory of the file relative to the scanned root ('' for direct file arguments) */
  relDir: string;
}

/** Collect Markdown files recursively from a directory (sorted by name) */
function collectMarkdown(root: string, dir: string, out: FoundFile[]): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectMarkdown(root, path, out);
    } else if (entry.isFile() && MD_EXTS.has(extname(entry.name).toLowerCase())) {
      out.push({ path, relDir: relative(root, dir).split(sep).join("/") });
    }
  }
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
  });
  if (parsed.positionals.length === 0) {
    throw new UsageError("import requires at least one <dir|file>");
  }

  const files: FoundFile[] = [];
  for (const path of parsed.positionals) {
    if (!existsSync(path)) throw new NotFoundError(`no such file or directory: ${path}`);
    if (statSync(path).isDirectory()) {
      collectMarkdown(path, path, files);
    } else {
      files.push({ path, relDir: "" });
    }
  }
  if (files.length === 0) throw new NotFoundError("no markdown files found");

  const { db } = getDb();
  const config = loadConfig();
  const bucketOverride = strOpt(parsed, "bucket");

  let created = 0;
  let updated = 0;
  const skipped: string[] = [];
  const skip = (path: string, reason: string): void => {
    skipped.push(path);
    console.error(`skip ${path}: ${reason}`);
  };

  for (const { path: file, relDir } of files) {
    const raw = readFileSync(file, "utf-8");
    let fmParsed: ReturnType<typeof parseFrontmatter>;
    try {
      fmParsed = parseFrontmatter(raw);
    } catch (e) {
      skip(file, e instanceof Error ? e.message : String(e));
      continue;
    }
    try {
      const { action } = importDocument(db, {
        fm: fmParsed.fm,
        body: fmParsed.body,
        fallbackTitle: basename(file, extname(file)),
        fallbackPath: relDir,
        bucketOverride,
        defaultBucket: config.general.default_bucket,
      });
      if (action === "created") created++;
      else updated++;
    } catch (e) {
      if (e instanceof ConflictError) {
        skip(file, e.message);
        continue;
      }
      throw e;
    }
  }

  if (boolOpt(parsed, "json")) {
    console.log(JSON.stringify({ created, updated, skipped }));
  } else {
    console.log(`imported: ${created} created, ${updated} updated, ${skipped.length} skipped`);
  }
  // Exit 0 when anything succeeded despite skips; 1 when everything failed
  return created + updated > 0 ? EXIT.OK : EXIT.ERROR;
}
