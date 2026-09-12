import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { createMcpServer } from "../../server/mcp";
import { boolOpt, EXIT, parseCommandArgs } from "../args";

export const summary = "Run the MCP server (stdio)";

export const usage = `Usage: kura mcp [--print-config]

Options:
  --print-config   Print config snippets for claude mcp add / .mcp.json`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    "print-config": { type: "boolean", default: false },
  });

  if (boolOpt(parsed, "print-config")) {
    console.log("# Claude Code:");
    console.log("claude mcp add kura -- kura mcp");
    console.log("");
    console.log("# .mcp.json:");
    console.log(
      JSON.stringify({ mcpServers: { kura: { command: "kura", args: ["mcp"] } } }, null, 2),
    );
    return EXIT.OK;
  }

  const config = loadConfig();
  const { db, tokenizer } = getDb();
  const server = createMcpServer({ db, tokenizer, config });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  await new Promise<void>((resolve, reject) => {
    let closing = false;
    const finish = () => {
      process.stdin.off("end", onEnd);
      resolve();
    };
    const onEnd = () => {
      if (closing) return;
      closing = true;
      server.close().then(finish, reject);
    };
    process.stdin.once("end", onEnd);
    server.server.onclose = finish;
    if (process.stdin.readableEnded) onEnd();
  });
  return EXIT.OK;
}
