import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { resolveDoc, updateDocument } from "../../core/documents";
import { type Frontmatter, parseFrontmatter, serializeFrontmatter } from "../../core/frontmatter";
import { removeTagsFromDoc } from "../../core/tags";
import { EXIT, parseCommandArgs, strOpt, UsageError } from "../args";

export const summary = "Edit a document with $EDITOR";

export const usage = `Usage: kura edit <doc> [--bucket b]

Writes frontmatter + body to a temporary file and opens it with
general.editor (config) → $EDITOR → vi. Changes to title / tags / bucket
in the frontmatter are applied on save. kura_key must not be changed.`;

/**
 * YAML が kura_key を数値として解釈するケース（全桁数字の hex キー）を
 * 生テキストから救済する。
 */
function rawFrontmatterKey(raw: string): string | undefined {
  const block = raw.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)/)?.[1] ?? "";
  return block.match(/^kura_key:[ \t]*["']?([0-9a-f]{8})["']?[ \t]*$/m)?.[1];
}

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, { bucket: { type: "string" } });
  const spec = parsed.positionals[0];
  if (!spec) throw new UsageError("edit requires <doc>");

  const { db } = getDb();
  const doc = resolveDoc(db, spec, strOpt(parsed, "bucket"));

  const fmText = serializeFrontmatter({
    kura_key: doc.key,
    title: doc.title,
    bucket: doc.bucket,
    tags: doc.tags,
    source_url: doc.sourceUrl,
    content_type: doc.contentType,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  });
  const original = `${fmText}\n\n${doc.content}`;
  const tmpPath = join(tmpdir(), `kura-edit-${doc.key}-${process.pid}-${Date.now()}.md`);
  writeFileSync(tmpPath, original);

  const config = loadConfig();
  const editor = config.general.editor.trim() || process.env.EDITOR?.trim() || "vi";
  const cmd = editor.split(/\s+/).filter((s) => s !== "");
  const result = Bun.spawnSync([...cmd, tmpPath], {
    stdio: ["inherit", "inherit", "inherit"],
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `editor exited with code ${result.exitCode}; changes discarded (kept at ${tmpPath})`,
    );
  }

  const edited = readFileSync(tmpPath, "utf-8");
  if (edited === original) {
    unlinkSync(tmpPath);
    console.log("no changes");
    return EXIT.OK;
  }

  let fm: Frontmatter | null;
  let body: string;
  try {
    ({ fm, body } = parseFrontmatter(edited));
  } catch (e) {
    throw new UsageError(
      `invalid frontmatter (${e instanceof Error ? e.message : e}); file kept at ${tmpPath}`,
    );
  }
  const editedKey = fm?.kura_key ?? rawFrontmatterKey(edited);
  if (editedKey !== doc.key) {
    throw new UsageError(
      `kura_key must not be changed (expected ${doc.key}); file kept at ${tmpPath}`,
    );
  }

  // fm の tags を正とし、現在のタグとの差分で追加/削除する
  const fmTags = fm?.tags ?? [];
  const removed = doc.tags.filter((t) => !fmTags.includes(t));
  const newTitle = fm?.title ?? doc.title;
  const { record, relinked } = updateDocument(db, doc.id, {
    title: newTitle,
    // frontmatter 直後の区切り空行 1 行を本文から除く
    content: body.replace(/^\r?\n/, ""),
    bucket: fm?.bucket ?? doc.bucket,
    tags: fmTags,
  });
  if (removed.length > 0) removeTagsFromDoc(db, record.id, removed);
  unlinkSync(tmpPath);

  let message = `updated #${record.key}  ${record.title}`;
  if (newTitle !== doc.title) message += `  (relinked ${relinked} documents)`;
  console.log(message);
  return EXIT.OK;
}
