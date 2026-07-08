import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { openBrowser, startServer } from "../../server/http";
import { boolOpt, EXIT, intOpt, parseCommandArgs } from "../args";

export const summary = "Start the browser UI server";

export const usage = `Usage: kura browser [--port 7578] [--no-open]

Options:
  --port n     Listen port (default: browser.port from config; retries +1 when in use)
  --no-open    Do not open the browser automatically`;

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

  // Stay resident until Ctrl-C
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
