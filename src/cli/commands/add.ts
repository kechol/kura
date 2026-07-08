import { basename, extname } from "node:path";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { createDocument, type DocumentRecord } from "../../core/documents";
import { type Frontmatter, parseFrontmatter } from "../../core/frontmatter";
import { boolOpt, EXIT, listOpt, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Add documents from files or stdin";

export const usage = `Usage:
  kura add <file>... [--bucket b] [--tags t1,t2] [--title T] [--type markdown|html]
  kura add - --title T          # read body from stdin

Options:
  --bucket <name>   Target bucket (default: general.default_bucket)
  --tags <t1,t2>    Comma-separated tags (overrides frontmatter tags)
  --title <title>   Document title (single input only; required for stdin)
  --type <type>     markdown | html (overrides frontmatter content_type)
  --json            Print created documents as JSON`;

/** frontmatter 直後の区切り空行 1 行を本文から除く */
function stripLeadingBlank(body: string): string {
  return body.replace(/^\r?\n/, "");
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    tags: { type: "string" },
    title: { type: "string" },
    type: { type: "string" },
  });
  const files = parsed.positionals;
  if (files.length === 0) throw new UsageError("add requires <file>... (or '-' for stdin)");

  const titleOpt = strOpt(parsed, "title");
  if (files.length > 1 && titleOpt !== undefined) {
    throw new UsageError("--title cannot be used with multiple files");
  }
  if (files.includes("-") && titleOpt === undefined) {
    throw new UsageError("--title is required when reading from stdin");
  }
  const typeOpt = strOpt(parsed, "type");
  if (typeOpt !== undefined && typeOpt !== "markdown" && typeOpt !== "html") {
    throw new UsageError(`--type must be markdown or html, got: ${typeOpt}`);
  }
  const bucketOpt = strOpt(parsed, "bucket");
  const tagsGiven = strOpt(parsed, "tags") !== undefined;
  const tagsOpt = listOpt(parsed, "tags");

  const { db } = getDb();
  const config = loadConfig();
  const created: DocumentRecord[] = [];

  for (const file of files) {
    const stdin = file === "-";
    const label = stdin ? "<stdin>" : file;
    const raw = stdin ? await Bun.stdin.text() : await readInput(file);

    let fm: Frontmatter | null;
    let body: string;
    try {
      ({ fm, body } = parseFrontmatter(raw));
    } catch (e) {
      throw new UsageError(`${label}: invalid frontmatter (${e instanceof Error ? e.message : e})`);
    }
    if (fm?.kura_key) {
      console.error(
        `warning: ${label}: frontmatter の kura_key は無視して新規作成します。更新には 'kura import' を使ってください`,
      );
    }

    // title 決定順: frontmatter.title → --title → ファイル名（拡張子除去）
    const fallback = stdin ? undefined : basename(file, extname(file));
    const title = fm?.title ?? titleOpt ?? fallback;
    if (title === undefined) throw new UsageError(`${label}: could not determine title`);

    const record = createDocument(db, {
      title,
      content: stripLeadingBlank(body),
      bucket: bucketOpt ?? fm?.bucket ?? config.general.default_bucket,
      contentType: typeOpt ?? fm?.content_type,
      sourceUrl: fm?.source_url ?? null,
      tags: tagsGiven ? tagsOpt : fm?.tags,
    });
    created.push(record);
  }

  if (boolOpt(parsed, "json")) {
    const out = created.map((d) => ({
      key: d.key,
      title: d.title,
      bucket: d.bucket,
      tags: d.tags,
      created_at: d.createdAt,
    }));
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const d of created) {
      console.log(`#${d.key}  ${d.title}  (${d.bucket})`);
    }
  }
  return EXIT.OK;
}

async function readInput(path: string): Promise<string> {
  const f = Bun.file(path);
  if (!(await f.exists())) throw new Error(`file not found: ${path}`);
  return f.text();
}
