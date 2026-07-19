#!/usr/bin/env bun
import { KURA_VERSION } from "../core/paths";
import { EXIT, LLMUnavailableError, NotFoundError, UsageError } from "./args";

interface CommandModule {
  summary: string;
  usage: string;
  run(argv: string[]): Promise<number> | number;
}

interface CommandDef {
  summary: string;
  load(): Promise<CommandModule>;
}

/**
 * Subcommand registry. Command bodies are lazily imported to reduce startup overhead.
 */
const commands: Record<string, CommandDef> = {
  init: {
    summary: "Initialize ~/.kura (extensions, DB, config)",
    load: () => import("./commands/init"),
  },
  doctor: {
    summary: "Diagnose installation and environment",
    load: () => import("./commands/doctor"),
  },
  status: {
    summary: "Show knowledge base statistics",
    load: () => import("./commands/status"),
  },
  config: {
    summary: "Read and write ~/.kura/config.toml",
    load: () => import("./commands/config"),
  },
  add: {
    summary: "Add documents from files or stdin",
    load: () => import("./commands/add"),
  },
  get: {
    summary: "Show a document",
    load: () => import("./commands/get"),
  },
  edit: {
    summary: "Edit a document with $EDITOR",
    load: () => import("./commands/edit"),
  },
  rm: {
    summary: "Delete a document",
    load: () => import("./commands/rm"),
  },
  mv: {
    summary: "Rename or move a document (relinks [[references]])",
    load: () => import("./commands/mv"),
  },
  ls: {
    summary: "List documents",
    load: () => import("./commands/ls"),
  },
  export: {
    summary: "Export documents as Markdown with frontmatter",
    load: () => import("./commands/export"),
  },
  import: {
    summary: "Import Markdown files (frontmatter round-trip)",
    load: () => import("./commands/import"),
  },
  bucket: {
    summary: "Manage buckets",
    load: () => import("./commands/bucket"),
  },
  tag: {
    summary: "Manage tags",
    load: () => import("./commands/tag"),
  },
  link: {
    summary: "Show links and backlinks",
    load: () => import("./commands/link"),
  },
  alias: {
    summary: "Manage document aliases (alternate titles)",
    load: () => import("./commands/alias"),
  },
  search: {
    summary: "Fast keyword search (FTS5 BM25)",
    load: () => import("./commands/search"),
  },
  vsearch: {
    summary: "Semantic vector search (KNN)",
    load: () => import("./commands/vsearch"),
  },
  query: {
    summary: "Hybrid RAG search (FTS + vector + rerank)",
    load: () => import("./commands/query"),
  },
  ask: {
    summary: "Answer a question from the knowledge base (cited sources)",
    load: () => import("./commands/ask"),
  },
  embed: {
    summary: "Generate embeddings for pending chunks",
    load: () => import("./commands/embed"),
  },
  mcp: {
    summary: "Run the MCP server (stdio)",
    load: () => import("./commands/mcp"),
  },
  skills: {
    summary: "Install the agent skill (a kura CLI guide for AI agents)",
    load: () => import("./commands/skills"),
  },
  browser: {
    summary: "Start the browser UI server",
    load: () => import("./commands/browser"),
  },
  clip: {
    summary: "Clip a web page into the knowledge base",
    load: () => import("./commands/clip"),
  },
};

function printHelp(): void {
  const lines = [
    `kura ${KURA_VERSION} — local knowledge management CLI`,
    "",
    "Usage: kura <command> [options]",
    "",
    "Commands:",
    ...Object.entries(commands).map(([name, def]) => `  ${name.padEnd(10)} ${def.summary}`),
    "",
    "Global options:",
    "  --json       Machine-readable output (read commands)",
    "  --help, -h   Show help",
    "  --version    Show version",
  ];
  console.log(lines.join("\n"));
}

export async function main(argv: string[]): Promise<number> {
  const [name, ...rest] = argv;

  if (!name || name === "help" || name === "--help" || name === "-h") {
    printHelp();
    return EXIT.OK;
  }
  if (name === "--version" || name === "-v" || name === "version") {
    console.log(KURA_VERSION);
    return EXIT.OK;
  }

  const def = commands[name];
  if (!def) {
    console.error(`kura: unknown command '${name}'\nRun 'kura --help' for usage.`);
    return EXIT.USAGE;
  }

  const mod = await def.load();
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(mod.usage);
    return EXIT.OK;
  }

  try {
    return await mod.run(rest);
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`kura ${name}: ${e.message}`);
      console.error(mod.usage);
      return EXIT.USAGE;
    }
    if (e instanceof NotFoundError) {
      console.error(`kura ${name}: ${e.message}`);
      return EXIT.NOT_FOUND;
    }
    if (e instanceof LLMUnavailableError) {
      console.error(`kura ${name}: ${e.message}`);
      console.error("Run 'kura doctor' to check LLM provider availability.");
      return EXIT.NO_LLM;
    }
    console.error(`kura ${name}: ${e instanceof Error ? e.message : String(e)}`);
    return EXIT.ERROR;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
