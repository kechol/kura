import { fetchAndExtract } from "../../core/clip/extract";
import { formatClip, suggestTagsForText } from "../../core/clip/format";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { createDocument, updateDocument } from "../../core/documents";
import { resolveProvider } from "../../core/llm/provider";
import { addTagsToDoc, listTags } from "../../core/tags";
import { boolOpt, EXIT, listOpt, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Clip a web page into the knowledge base";

export const usage = `Usage: kura clip <url> [--bucket b] [--tags t1,t2] [--no-llm] [--dry-run] [--force]

Options:
  --no-llm    Convert mechanically with turndown, without LLM formatting or tag suggestions
  --dry-run   Print the formatted result without saving
  --force     Overwrite an existing document with the same URL without confirmation`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    tags: { type: "string" },
    "no-llm": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    force: { type: "boolean", default: false },
  });
  const url = parsed.positionals[0];
  if (!url) throw new UsageError("clip requires <url>");
  if (!/^https?:\/\//.test(url)) throw new UsageError(`invalid url: ${url}`);
  const noLlm = boolOpt(parsed, "no-llm");

  const config = loadConfig();
  const { db } = getDb();
  const provider = noLlm ? null : await resolveProvider(config);
  if (!noLlm && !provider) {
    console.error("warning: no LLM provider available; importing with turndown conversion only");
  }

  console.error(`fetching ${url} ...`);
  const page = await fetchAndExtract(url);
  const formatted = await formatClip(db, provider, config, page, { noLlm });

  // Tag suggestion (prefers existing tags, docs: cli-reference.md)
  const manualTags = listOpt(parsed, "tags");
  let suggested: string[] = [];
  if (provider) {
    try {
      suggested = await suggestTagsForText(
        db,
        provider,
        config,
        `${formatted.title}\n\n${formatted.markdown}`,
        listTags(db).map((t) => t.path),
      );
    } catch (e) {
      console.error(`warning: tag suggestion failed (${e instanceof Error ? e.message : e})`);
    }
  }

  if (boolOpt(parsed, "dry-run")) {
    console.log(`# ${formatted.title}`);
    console.log("");
    console.log(
      `> url: ${url} / formatter: ${formatted.llmFormatted ? "llm" : "turndown"} / tags: ${[...manualTags, ...suggested].join(", ") || "(none)"}`,
    );
    console.log("");
    console.log(formatted.markdown);
    return EXIT.OK;
  }

  const bucket = strOpt(parsed, "bucket") ?? config.general.default_bucket;
  const existing = db
    .prepare(
      `SELECT d.id, d.doc_key, d.title FROM documents d
       JOIN buckets b ON b.id = d.bucket_id WHERE d.source_url = ? AND b.name = ?`,
    )
    .get(url, bucket) as { id: number; doc_key: string; title: string } | null;

  if (existing) {
    if (!boolOpt(parsed, "force")) {
      const isTty = process.stdout.isTTY === true && process.stdin.isTTY === true;
      if (!isTty) {
        console.error(
          `a document with the same URL already exists: #${existing.doc_key} ${existing.title} (use --force to overwrite)`,
        );
        return EXIT.ERROR;
      }
      process.stdout.write(
        `update document #${existing.doc_key} "${existing.title}" with the same URL? [y/N] `,
      );
      const answer = await new Promise<string>((resolve) => {
        process.stdin.once("data", (d) => resolve(String(d)));
      });
      if (!/^y(es)?$/i.test(answer.trim())) {
        console.log("aborted");
        return EXIT.OK;
      }
    }
    const { record } = updateDocument(db, existing.id, {
      title: formatted.title,
      content: formatted.markdown,
      tags: manualTags,
    });
    if (suggested.length > 0) addTagsToDoc(db, record.id, suggested, "auto");
    console.log(`updated #${record.key}  ${record.title}`);
    return EXIT.OK;
  }

  const record = createDocument(db, {
    title: formatted.title,
    content: formatted.markdown,
    bucket,
    sourceUrl: url,
    tags: manualTags,
  });
  if (suggested.length > 0) addTagsToDoc(db, record.id, suggested, "auto");
  const allTags = [...record.tags, ...suggested];
  console.log(
    `clipped #${record.key}  ${record.title}  (${bucket})${allTags.length > 0 ? `  tags: ${[...new Set(allTags)].join(", ")}` : ""}`,
  );
  return EXIT.OK;
}
