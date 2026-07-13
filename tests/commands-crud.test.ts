import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<CliResult> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, NO_COLOR: "1", ...env },
    stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
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

const homes: string[] = [];

/** Create an isolated KURA_HOME per scenario and set up the DB with kura init */
async function makeHome(): Promise<{ home: string; env: Record<string, string> }> {
  const home = mkdtempSync(join(tmpdir(), "kura-crud-test-"));
  homes.push(home);
  const env = { KURA_HOME: home };
  const init = await runCli(["init", "--no-download"], env);
  expect(init.code).toBe(0);
  return { home, env };
}

afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

function keyOf(stdout: string): string {
  const m = stdout.match(/#([0-9a-f]{8})/);
  if (!m) throw new Error(`doc key not found in output: ${stdout}`);
  return m[1]!;
}

describe("kura CRUD commands (e2e)", () => {
  test("add: file with Japanese frontmatter → ls / get --raw / --json / --lines", async () => {
    const { home, env } = await makeHome();
    const body = [
      "WAL モードは読み取りと書き込みを並行できる。",
      "",
      "詳細は [[トランザクション分離]] を参照。チェックポイントの間隔にも注意する。",
    ].join("\n");
    const file = join(home, "wal.md");
    writeFileSync(
      file,
      [
        "---",
        "title: SQLite の WAL モード",
        "tags: [tech/db/sqlite, 技術メモ]",
        "source_url: https://example.com/wal",
        "---",
        "",
        body,
      ].join("\n"),
    );

    const added = await runCli(["add", file], env);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("SQLite の WAL モード");
    expect(added.stdout).toContain("(main)");
    const key = keyOf(added.stdout);

    const ls = await runCli(["ls"], env);
    expect(ls.code).toBe(0);
    expect(ls.stdout).toContain("SQLite の WAL モード");
    expect(ls.stdout).toContain("tech/db/sqlite");
    expect(ls.stdout.trim().endsWith("1 documents")).toBe(true);

    const raw = await runCli(["get", `#${key}`, "--raw"], env);
    expect(raw.code).toBe(0);
    expect(raw.stdout).toBe(`${body}\n`);

    const json = await runCli(["get", "SQLite の WAL モード", "--json"], env);
    expect(json.code).toBe(0);
    const doc = JSON.parse(json.stdout);
    expect(doc.key).toBe(key);
    expect(doc.title).toBe("SQLite の WAL モード");
    expect(doc.bucket).toBe("main");
    expect(doc.tags).toContain("tech/db/sqlite");
    expect(doc.tags).toContain("技術メモ");
    expect(doc.content).toBe(body);
    expect(doc.content_type).toBe("markdown");
    expect(doc.source_url).toBe("https://example.com/wal");
    expect(typeof doc.created_at).toBe("string");
    expect(typeof doc.updated_at).toBe("string");
    expect(doc.access_count).toBeGreaterThanOrEqual(1);

    const lines = await runCli(["get", `#${key}`, "--raw", "--lines", "1:1"], env);
    expect(lines.stdout).toBe("WAL モードは読み取りと書き込みを並行できる。\n");
    const tail = await runCli(["get", `#${key}`, "--raw", "--lines", "3:"], env);
    expect(tail.stdout).toBe(
      "詳細は [[トランザクション分離]] を参照。チェックポイントの間隔にも注意する。\n",
    );
  }, 30_000);

  test("add -: adds from stdin with --title / exits 2 without --title", async () => {
    const { env } = await makeHome();

    const ok = await runCli(
      ["add", "-", "--title", "標準入力メモ", "--tags", "メモ/日次"],
      env,
      "標準入力から取り込んだ本文です。\n",
    );
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("標準入力メモ");

    const raw = await runCli(["get", "標準入力メモ", "--raw"], env);
    expect(raw.code).toBe(0);
    expect(raw.stdout).toContain("標準入力から取り込んだ本文です。");

    const noTitle = await runCli(["add", "-"], env, "タイトルのない本文");
    expect(noTitle.code).toBe(2);
  }, 30_000);

  test("mv: rename rewrites [[links]] in referring documents", async () => {
    const { home, env } = await makeHome();
    const fileA = join(home, "a.md");
    writeFileSync(fileA, "リンクされる側の本文。");
    const fileB = join(home, "b.md");
    writeFileSync(fileB, "参照は [[旧ドキュメント]] を見ること。");

    const a = await runCli(["add", fileA, "--title", "旧ドキュメント"], env);
    expect(a.code).toBe(0);
    const b = await runCli(["add", fileB, "--title", "参照元メモ"], env);
    expect(b.code).toBe(0);

    const mv = await runCli(["mv", "旧ドキュメント", "新ドキュメント"], env);
    expect(mv.code).toBe(0);
    expect(mv.stdout).toContain("renamed");
    expect(mv.stdout).toContain("旧ドキュメント -> 新ドキュメント");
    expect(mv.stdout).toContain("relinked 1");

    const referrer = await runCli(["get", "参照元メモ", "--raw"], env);
    expect(referrer.stdout).toContain("[[新ドキュメント]]");
    expect(referrer.stdout).not.toContain("[[旧ドキュメント]]");
  }, 30_000);

  test("rm: exits 2 without --force on non-TTY / --force deletes and removes from ls", async () => {
    const { env } = await makeHome();
    const added = await runCli(["add", "-", "--title", "削除対象メモ"], env, "消される本文。");
    expect(added.code).toBe(0);
    const key = keyOf(added.stdout);

    const refused = await runCli(["rm", `#${key}`], env);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("--force");

    const removed = await runCli(["rm", `#${key}`, "--force"], env);
    expect(removed.code).toBe(0);
    expect(removed.stdout).toContain(`deleted #${key}`);
    expect(removed.stdout).toContain("削除対象メモ");

    const ls = await runCli(["ls"], env);
    expect(ls.stdout).not.toContain("削除対象メモ");
    expect(ls.stdout.trim().endsWith("0 documents")).toBe(true);
  }, 30_000);

  test("edit: rewrites the body via an EDITOR script / prints no changes when unchanged", async () => {
    const { home, env } = await makeHome();
    const added = await runCli(["add", "-", "--title", "編集メモ"], env, "編集前の本文です。");
    expect(added.code).toBe(0);
    const key = keyOf(added.stdout);

    // Fake editor that replaces part of the body of the given file and saves it
    const editor = join(home, "editor.ts");
    writeFileSync(
      editor,
      [
        "const path = process.argv[2]!;",
        "const text = await Bun.file(path).text();",
        'await Bun.write(path, text.replace("編集前の本文", "編集後の本文"));',
      ].join("\n"),
    );

    const edited = await runCli(["edit", `#${key}`], { ...env, EDITOR: `bun ${editor}` });
    expect(edited.code).toBe(0);
    expect(edited.stdout).toContain(`updated #${key}`);

    const raw = await runCli(["get", `#${key}`, "--raw"], env);
    expect(raw.stdout).toContain("編集後の本文です。");

    // Editor that does nothing → no changes
    const noop = join(home, "noop.ts");
    writeFileSync(noop, "");
    const unchanged = await runCli(["edit", `#${key}`], { ...env, EDITOR: `bun ${noop}` });
    expect(unchanged.code).toBe(0);
    expect(unchanged.stdout).toContain("no changes");
  }, 30_000);

  test("referencing a nonexistent doc exits 3", async () => {
    const { env } = await makeHome();
    const byTitle = await runCli(["get", "存在しないメモ"], env);
    expect(byTitle.code).toBe(3);
    const byKey = await runCli(["get", "#deadbeef"], env);
    expect(byKey.code).toBe(3);
    const rm = await runCli(["rm", "存在しないメモ", "--force"], env);
    expect(rm.code).toBe(3);
  }, 30_000);

  test("ls: --tag / --bucket / --sort title / --limit / --json", async () => {
    const { env } = await makeHome();
    const docs: Array<[string, string, string]> = [
      ["あんずのメモ", "tech/db", "あんずの本文。"],
      ["かえでのメモ", "tech/web", "かえでの本文。"],
      ["さくらのメモ", "日記/2026", "さくらの本文。"],
    ];
    for (const [title, tag, body] of docs) {
      const r = await runCli(["add", "-", "--title", title, "--tags", tag], env, body);
      expect(r.code).toBe(0);
    }

    const byTag = await runCli(["ls", "--tag", "tech"], env);
    expect(byTag.code).toBe(0);
    expect(byTag.stdout).toContain("あんずのメモ");
    expect(byTag.stdout).toContain("かえでのメモ");
    expect(byTag.stdout).not.toContain("さくらのメモ");
    expect(byTag.stdout.trim().endsWith("2 documents")).toBe(true);

    const byBucket = await runCli(["ls", "--bucket", "main"], env);
    expect(byBucket.code).toBe(0);
    expect(byBucket.stdout.trim().endsWith("3 documents")).toBe(true);

    const byTitle = await runCli(["ls", "--sort", "title"], env);
    expect(byTitle.code).toBe(0);
    const iA = byTitle.stdout.indexOf("あんずのメモ");
    const iK = byTitle.stdout.indexOf("かえでのメモ");
    const iS = byTitle.stdout.indexOf("さくらのメモ");
    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iA).toBeLessThan(iK);
    expect(iK).toBeLessThan(iS);

    const badSort = await runCli(["ls", "--sort", "size"], env);
    expect(badSort.code).toBe(2);

    const limited = await runCli(["ls", "--limit", "2"], env);
    expect(limited.code).toBe(0);
    const lines = limited.stdout.trim().split("\n");
    expect(lines.length).toBe(3);
    expect(lines[2]).toBe("2 documents");

    const json = await runCli(["ls", "--json"], env);
    expect(json.code).toBe(0);
    const list = JSON.parse(json.stdout);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(3);
    for (const d of list) {
      expect(typeof d.key).toBe("string");
      expect(typeof d.title).toBe("string");
      expect(d.bucket).toBe("main");
      expect(Array.isArray(d.tags)).toBe(true);
      expect(typeof d.created_at).toBe("string");
      expect(typeof d.updated_at).toBe("string");
      expect(typeof d.access_count).toBe("number");
    }
  }, 30_000);

  test("path: add --path / ls --prefix / get by full path / mv --path / mv --prefix", async () => {
    const { env } = await makeHome();
    const add = await runCli(
      ["add", "-", "--title", "SQLite メモ", "--path", "db/sqlite"],
      env,
      "WAL モードの整理。\n",
    );
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("db/sqlite/SQLite メモ");

    const ls = await runCli(["ls", "--prefix", "db", "--json"], env);
    expect(ls.code).toBe(0);
    const docs = JSON.parse(ls.stdout) as Array<{ path: string }>;
    expect(docs.length).toBe(1);
    expect(docs[0]?.path).toBe("db/sqlite");

    const get = await runCli(["get", "db/sqlite/SQLite メモ", "--json"], env);
    expect(get.code).toBe(0);
    expect(JSON.parse(get.stdout).path).toBe("db/sqlite");

    const mv = await runCli(["mv", "db/sqlite/SQLite メモ", "--path", "database"], env);
    expect(mv.code).toBe(0);
    expect(mv.stdout).toContain("database/SQLite メモ");

    const prefix = await runCli(["mv", "--prefix", "database", "db2"], env);
    expect(prefix.code).toBe(0);
    expect(prefix.stdout).toContain("1 documents moved");
    const after = await runCli(["ls", "--prefix", "db2", "--json"], env);
    expect((JSON.parse(after.stdout) as unknown[]).length).toBe(1);
  }, 30_000);

  test("mv suggest: signal-based suggestions in --json, applied with --apply", async () => {
    const { env } = await makeHome();
    // Deterministic degraded mode: never probe a live provider (testing.md R2)
    const cfg = await runCli(["config", "set", "llm.provider", "none"], env);
    expect(cfg.code).toBe(0);

    await runCli(
      ["add", "-", "--title", "SQLiteの内部構造", "--path", "db/sqlite"],
      env,
      "Btree の話。 #tech/db\n",
    );
    const unfiled = await runCli(
      ["add", "-", "--title", "WALメモ"],
      env,
      "[[SQLiteの内部構造]] を参照。 #tech/db\n",
    );
    expect(unfiled.code).toBe(0);

    const json = await runCli(["mv", "suggest", "--json"], env);
    expect(json.code).toBe(0);
    expect(json.stderr).toContain("no LLM provider");
    const results = JSON.parse(json.stdout) as Array<{
      title: string;
      suggestion: { path: string; source: string } | null;
    }>;
    expect(results.length).toBe(1);
    expect(results[0]?.title).toBe("WALメモ");
    expect(results[0]?.suggestion?.path).toBe("db/sqlite");
    expect(results[0]?.suggestion?.source).toBe("signals");

    const applied = await runCli(["mv", "suggest", "--apply"], env);
    expect(applied.code).toBe(0);
    expect(applied.stdout).toContain("moved -> db/sqlite/WALメモ");

    const get = await runCli(["get", "db/sqlite/WALメモ", "--json"], env);
    expect(JSON.parse(get.stdout).path).toBe("db/sqlite");

    const empty = await runCli(["mv", "suggest", "--json"], env);
    expect(empty.stdout.trim()).toBe("[]");
  }, 30_000);
});
