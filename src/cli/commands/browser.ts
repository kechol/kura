import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { openBrowser, startServer } from "../../server/http";
import { boolOpt, EXIT, intOpt, parseCommandArgs } from "../args";

export const summary = "Start the browser UI server";

export const usage = `Usage: kura browser [--port 7578] [--no-open]

Options:
  --port n     待ち受けポート（既定: config の browser.port。使用中なら +1 リトライ）
  --no-open    ブラウザを自動で開かない`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    port: { type: "string" },
    "no-open": { type: "boolean", default: false },
  });
  const config = loadConfig();
  const { db, tokenizer } = getDb();

  const server = startServer({
    db,
    tokenizer,
    config,
    port: intOpt(parsed, "port") ?? config.browser.port,
  });
  console.log(`kura browser: ${server.url}`);
  if (!boolOpt(parsed, "no-open")) openBrowser(server.url);

  // Ctrl-C まで常駐
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.stop();
      resolve();
    });
    process.on("SIGTERM", () => {
      server.stop();
      resolve();
    });
  });
  return EXIT.OK;
}
