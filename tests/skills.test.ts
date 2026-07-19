import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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

// The skills target derives from homedir(), so HOME (not KURA_HOME) isolates it
const home = mkdtempSync(join(tmpdir(), "kura-skills-test-"));
const env = { HOME: home, KURA_HOME: join(home, ".kura") };
const target = join(home, ".agents", "skills", "kura-cli", "SKILL.md");

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("kura skills", () => {
  test("install writes SKILL.md under ~/.agents/skills", async () => {
    const r = await runCli(["skills", "install"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Installed ${target}`);
    expect(existsSync(target)).toBe(true);

    const content = readFileSync(target, "utf8");
    expect(content.startsWith("---\nname: kura-cli\n")).toBe(true);
    expect(content).toContain("description:");
    expect(content).toContain("kura search");
    expect(content).toContain("kura vsearch");
    expect(content).toContain("kura query");
    // The version placeholder must be resolved at install time
    expect(content).not.toContain("{{KURA_VERSION}}");
    // Examples stay Japanese — kura is a Japanese-first tool
    expect(content).toContain("技術/データベース");
  });

  test("reinstall is idempotent and reports unchanged", async () => {
    const r = await runCli(["skills", "install", "--json"], env);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.action).toBe("unchanged");
    expect(out.path).toBe(target);
  });

  test("show prints the skill to stdout", async () => {
    const r = await runCli(["skills", "show"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("name: kura-cli");
    expect(r.stdout).toContain("Exit codes");
  });

  test("--dir overrides the skills directory", async () => {
    const dir = join(home, "project", ".claude", "skills");
    const r = await runCli(["skills", "install", "--dir", dir], env);
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, "kura-cli", "SKILL.md"))).toBe(true);
  });

  test("uninstall removes the skill; a second uninstall exits 3", async () => {
    const first = await runCli(["skills", "uninstall"], env);
    expect(first.code).toBe(0);
    expect(existsSync(target)).toBe(false);
    // The now-empty kura-cli directory goes too
    expect(existsSync(join(home, ".agents", "skills", "kura-cli"))).toBe(false);

    const second = await runCli(["skills", "uninstall"], env);
    expect(second.code).toBe(3);
    expect(second.stderr).toContain("not installed");
  });

  test("a missing subcommand is a usage error", async () => {
    const r = await runCli(["skills"], env);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("install / uninstall / show");
  });
});
