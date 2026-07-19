import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KURA_VERSION } from "../../core/paths";
import { boolOpt, EXIT, NotFoundError, parseCommandArgs, strOpt, UsageError } from "../args";
import skillTemplate from "../skills/kura-cli/SKILL.md" with { type: "text" };

export const summary = "Install the agent skill (a kura CLI guide for AI agents)";

export const usage = `Usage:
  kura skills install [--dir <path>] [--json]
  kura skills uninstall [--dir <path>]
  kura skills show

Manages kura-cli/SKILL.md — a guide that teaches AI coding agents to operate
kura from the command line (docs: cli-reference.md).

Options:
  --dir <path>   Skills directory to use instead of ~/.agents/skills
                 (e.g. a project's .claude/skills or .agents/skills)
  --json         install: print { action, path } as JSON

Subcommands:
  install     Write <dir>/kura-cli/SKILL.md (idempotent; overwrites on upgrade)
  uninstall   Remove the installed skill
  show        Print the skill to stdout (review, or redirect anywhere)`;

const SKILL_NAME = "kura-cli";

function skillContent(): string {
  return skillTemplate.replace("{{KURA_VERSION}}", KURA_VERSION);
}

export function run(argv: string[]): number {
  const parsed = parseCommandArgs(argv, { dir: { type: "string" } });
  const [sub, ...extra] = parsed.positionals;
  if (extra.length > 0) throw new UsageError(`unexpected argument: ${extra[0]}`);

  const baseDir = strOpt(parsed, "dir") ?? join(homedir(), ".agents", "skills");
  const skillDir = join(baseDir, SKILL_NAME);
  const target = join(skillDir, "SKILL.md");

  switch (sub) {
    case "install": {
      const content = skillContent();
      const action = !existsSync(target)
        ? "installed"
        : readFileSync(target, "utf8") === content
          ? "unchanged"
          : "updated";
      if (action !== "unchanged") {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(target, content);
      }
      if (boolOpt(parsed, "json")) {
        console.log(JSON.stringify({ action, path: target }));
      } else if (action === "unchanged") {
        console.log(`Already up to date: ${target}`);
      } else {
        console.log(`${action === "installed" ? "Installed" : "Updated"} ${target}`);
      }
      return EXIT.OK;
    }
    case "uninstall": {
      if (!existsSync(target)) throw new NotFoundError(`not installed: ${target}`);
      rmSync(target);
      // Take the kura-cli directory with it, but only when nothing else is inside
      if (readdirSync(skillDir).length === 0) rmSync(skillDir, { recursive: true });
      console.log(`Removed ${target}`);
      return EXIT.OK;
    }
    case "show": {
      process.stdout.write(skillContent());
      return EXIT.OK;
    }
    case undefined:
      throw new UsageError("skills requires a subcommand: install / uninstall / show");
    default:
      throw new UsageError(`unknown subcommand: ${sub}`);
  }
}
