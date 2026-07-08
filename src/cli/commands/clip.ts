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
  --no-llm    LLM 整形・タグ提案を使わず turndown で機械変換
  --dry-run   保存せず整形結果を表示
  --force     同一 URL の既存ドキュメントを確認なしで上書き更新`;

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
    console.error("warning: LLM プロバイダ不在のため turndown 変換のみで取り込みます");
  }

  console.error(`fetching ${url} ...`);
  const page = await fetchAndExtract(url);
  const formatted = await formatClip(db, provider, config, page, { noLlm });

  // タグ提案（既存タグ優先、SPEC §7.5）
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
      console.error(`warning: タグ提案に失敗しました（${e instanceof Error ? e.message : e}）`);
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
          `同一 URL のドキュメントが存在します: #${existing.doc_key} ${existing.title}（--force で上書き）`,
        );
        return EXIT.ERROR;
      }
      process.stdout.write(
        `同一 URL のドキュメント #${existing.doc_key} 「${existing.title}」を更新しますか? [y/N] `,
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
