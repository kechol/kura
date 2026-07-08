import { loadConfig } from "../../core/config";
import { getDb, setMeta } from "../../core/db";
import { requireProvider } from "../../core/llm/provider";
import { backfillEmbeddings, pendingChunkCount } from "../../core/search/vector";
import { boolOpt, EXIT, parseCommandArgs } from "../args";

export const summary = "Generate embeddings for pending chunks";

export const usage = `Usage: kura embed [--all]

Options:
  --all   既存を破棄して全チャンクを再 embedding（モデル変更後などに使用）`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    all: { type: "boolean", default: false },
  });
  const all = boolOpt(parsed, "all");
  const config = loadConfig();
  const { db } = getDb();

  if (!all && pendingChunkCount(db) === 0) {
    console.log("all chunks are already embedded");
    return EXIT.OK;
  }
  const provider = await requireProvider(config);

  const isTty = process.stderr.isTTY === true;
  const result = await backfillEmbeddings(db, provider, config, {
    all,
    onProgress: (done, total) => {
      if (isTty) {
        process.stderr.write(`\rembedding ${done}/${total}`);
        if (done === total) process.stderr.write("\n");
      } else if (done % 160 === 0 || done === total) {
        console.error(`embedding ${done}/${total}`);
      }
    },
  });

  // 再 embedding 完了時に使用モデルを meta に記録（doctor の変更検知用）
  setMeta(db, "embedding_model", config.llm.models.embedding);
  setMeta(db, "embedding_dimensions", String(config.llm.models.embedding_dimensions));

  console.log(`embedded ${result.embedded} chunks (model: ${config.llm.models.embedding})`);
  return EXIT.OK;
}
