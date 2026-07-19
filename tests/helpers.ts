import { join } from "node:path";

/**
 * Shared CLI subprocess harness (not collected by bun test — no .test suffix).
 * Spawns the CLI from source with NO_COLOR and the caller's KURA_HOME/KURA_DB
 * env so tests never touch the real ~/.kura (testing.md R1).
 */

export const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}
