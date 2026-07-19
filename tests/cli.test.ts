import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
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

describe("cli dispatch", () => {
  test("--version prints the version", async () => {
    const r = await runCli(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  test("--help prints the command list", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: kura <command>");
    expect(r.stdout).toContain("config");
    // The restructured organizing surface: the triage pipeline and the audit umbrella
    expect(r.stdout).toContain("triage");
    expect(r.stdout).toContain("audit");
  });

  test("no arguments prints help and exits 0", async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Usage: kura <command>");
  });

  test("unknown command exits 2", async () => {
    const r = await runCli(["nope"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("unknown command");
  });

  test("invalid options exit 2 and print usage", async () => {
    const r = await runCli(["config", "--bogus"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Usage:");
  });
});
