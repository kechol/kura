import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

async function runCli(
  args: string[],
  env: Record<string, string>,
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

describe("kura init (e2e)", () => {
  test("--no-download で config と DB を作成し、再実行は冪等", async () => {
    const home = mkdtempSync(join(tmpdir(), "kura-init-test-"));
    const env = { KURA_HOME: home };

    const first = await runCli(["init", "--no-download"], env);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("created");
    expect(first.stdout).toContain("tokenizer: trigram");
    expect(existsSync(join(home, "config.toml"))).toBe(true);
    expect(existsSync(join(home, "kura.db"))).toBe(true);

    const second = await runCli(["init", "--no-download"], env);
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("exists, kept");
    expect(second.stdout).toContain("0 documents");
  });

  test("init 前の DB 依存コマンドは...(現時点で対象コマンドなし、doctor が警告を出す)", async () => {
    const home = mkdtempSync(join(tmpdir(), "kura-doctor-test-"));
    const r = await runCli(["doctor"], { KURA_HOME: home });
    expect(r.stdout).toContain("kura init");
    expect(r.stdout).toContain("checks:");
  }, 15_000);
});
