import { existsSync, mkdirSync } from "node:fs";
import { ensureVaporetto, vaporettoSupported } from "../../core/bootstrap";
import { defaultConfig, loadConfig, saveConfig } from "../../core/config";
import { openDatabase } from "../../core/db";
import { configPath, dbPath, kuraHome, libDir } from "../../core/paths";
import { boolOpt, EXIT, parseCommandArgs } from "../args";

export const summary = "Initialize ~/.kura (extensions, DB, config)";

export const usage = `Usage: kura init [--no-download]

Options:
  --no-download   Skip downloading the sqlite-vaporetto extension
                  (falls back to the trigram tokenizer)`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    "no-download": { type: "boolean", default: false },
  });
  const download = !boolOpt(parsed, "no-download");

  mkdirSync(kuraHome(), { recursive: true });
  mkdirSync(libDir(), { recursive: true });

  if (existsSync(configPath())) {
    console.log(`config:    ${configPath()} (exists, kept)`);
  } else {
    saveConfig(defaultConfig());
    console.log(`config:    ${configPath()} (created)`);
  }
  const config = loadConfig();

  if (vaporettoSupported()) {
    try {
      const path = await ensureVaporetto({ download });
      if (path) {
        console.log(`vaporetto: ${path}`);
      } else {
        console.log("vaporetto: not installed (--no-download). FTS falls back to trigram");
      }
    } catch (e) {
      console.error(
        `warning: failed to download sqlite-vaporetto (${e instanceof Error ? e.message : e})`,
      );
      console.error("warning: FTS falls back to trigram; you can rerun 'kura init' later");
    }
  } else {
    console.log(
      `vaporetto: unsupported on ${process.platform}-${process.arch}. FTS falls back to trigram`,
    );
  }

  const dbExisted = dbPath() !== ":memory:" && existsSync(dbPath());
  const { db, tokenizer, warnings } = openDatabase();
  for (const w of warnings) console.error(`warning: ${w}`);
  const docs = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
  db.close();

  console.log(`db:        ${dbPath()} (${dbExisted ? `exists, ${docs} documents` : "created"})`);
  console.log(`tokenizer: ${tokenizer}`);
  console.log("");
  console.log("Next steps:");
  console.log(`  ollama pull ${config.llm.models.embedding}`);
  console.log(`  ollama pull ${config.llm.models.reranker}`);
  console.log(`  ollama pull ${config.llm.models.generation}`);
  console.log("  kura doctor   # diagnose the environment");
  return EXIT.OK;
}
