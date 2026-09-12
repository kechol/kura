import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { requireProvider } from "../../core/llm/provider";
import {
  assertEmbeddingIdentity,
  backfillEmbeddings,
  pendingChunkCount,
} from "../../core/search/vector";
import { boolOpt, EXIT, parseCommandArgs } from "../args";

export const summary = "Generate embeddings for pending chunks";

export const usage = `Usage: kura embed [--all]

Options:
  --all   Discard existing embeddings and re-embed all chunks (e.g. after a model change)`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    all: { type: "boolean", default: false },
  });
  const all = boolOpt(parsed, "all");
  const config = loadConfig();
  const { db } = getDb();

  if (!all) {
    assertEmbeddingIdentity(db, config);
    if (pendingChunkCount(db) === 0) {
      console.log("all chunks are already embedded");
      return EXIT.OK;
    }
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

  console.log(`embedded ${result.embedded} chunks (model: ${config.llm.models.embedding})`);
  return EXIT.OK;
}
