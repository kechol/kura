import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");
const homes: string[] = [];

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

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

  test("integer options reject non-positive and non-integer values with exit 2", async () => {
    const home = mkdtempSync(join(tmpdir(), "kura-cli-integer-test-"));
    homes.push(home);
    const env = { KURA_HOME: home, KURA_DB: join(home, "kura.db") };
    expect((await runCli(["init", "--no-download"], env)).code).toBe(0);

    for (const value of ["0", "-1", "1.5", "10junk", "9007199254740992"]) {
      const result = await runCli(["search", "設計", `--limit=${value}`], env);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("must be a positive integer");
    }
  });

  test("config set rejects sections and invalid numbers without changing the file", async () => {
    const home = mkdtempSync(join(tmpdir(), "kura-cli-config-test-"));
    homes.push(home);
    const env = { KURA_HOME: home, KURA_DB: join(home, "kura.db") };
    expect((await runCli(["init", "--no-download"], env)).code).toBe(0);
    const path = join(home, "config.toml");
    const before = readFileSync(path, "utf-8");

    for (const [key, value] of [
      ["search", "broken"],
      ["llm.models", "broken"],
      ["general.stale_days", ""],
      ["general.stale_days", "Infinity"],
      ["search.rrf_k", ""],
      ["browser.port", "65536"],
    ] as const) {
      const result = await runCli(["config", "set", key, value], env);
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("unknown config key or invalid value");
      expect(readFileSync(path, "utf-8")).toBe(before);
    }

    expect((await runCli(["config", "set", "general.stale_days", "90"], env)).code).toBe(0);
    expect(readFileSync(path, "utf-8")).toContain("stale_days = 90");
  });
});
