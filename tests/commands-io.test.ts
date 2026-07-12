import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");

async function runCli(
  args: string[],
  env: Record<string, string>,
  stdin?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
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

const homeA = mkdtempSync(join(tmpdir(), "kura-io-a-"));
const homeB = mkdtempSync(join(tmpdir(), "kura-io-b-"));
const work = mkdtempSync(join(tmpdir(), "kura-io-files-"));
const envA = { KURA_HOME: homeA };
const envB = { KURA_HOME: homeB };

const fixtureDir = join(work, "fixtures");
const exportDir = join(work, "export1");
const tagExportDir = join(work, "export-tag");

/** Japanese document fixtures (with frontmatter, no kura_key) */
const FIXTURES: Record<string, string> = {
  "wal.md": `---
title: SQLite の WAL モード
tags: [技術/データベース, tech/sqlite]
---

WAL モードは読み取りと書き込みを並行できるジャーナルモード。

チェックポイントの調整が運用上のポイントになる。
`,
  "vaporetto.md": `---
title: 日本語トークナイザー Vaporetto
tags: [技術/検索]
---

Vaporetto は点予測に基づく高速な形態素解析器。[[SQLite の WAL モード]] とあわせて使う。
`,
  "sanitize.md": `---
title: 設計/実装メモ
tags: [技術/データベース]
---

スラッシュを含むタイトルの検証用ドキュメント。
`,
};

describe("kura export / import / bucket (e2e)", () => {
  beforeAll(async () => {
    for (const env of [envA, envB]) {
      const r = await runCli(["init", "--no-download"], env);
      expect(r.code).toBe(0);
    }
    mkdirSync(fixtureDir, { recursive: true });
    for (const [name, content] of Object.entries(FIXTURES)) {
      writeFileSync(join(fixtureDir, name), content);
    }
  }, 60_000);

  test("import: creates 3 new Japanese documents", async () => {
    const r = await runCli(["import", fixtureDir, "--json"], envA);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ created: 3, updated: 0, skipped: [] });
  }, 20_000);

  test("export: writes files with frontmatter and sanitizes titles", async () => {
    const r = await runCli(["export", "--dir", exportDir], envA);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`exported 3 documents to ${exportDir}`);

    const walPath = join(exportDir, "main", "SQLite の WAL モード.md");
    expect(existsSync(walPath)).toBe(true);
    const wal = readFileSync(walPath, "utf-8");
    expect(wal).toMatch(/kura_key: "[0-9a-f]{8}"\n/);
    expect(wal).toContain('title: "SQLite の WAL モード"');
    expect(wal).toContain("bucket:");
    expect(wal).toContain("技術/データベース");
    expect(wal).toContain("tech/sqlite");
    expect(wal).toContain("チェックポイントの調整");

    // / in titles is replaced with -
    expect(existsSync(join(exportDir, "main", "設計-実装メモ.md"))).toBe(true);
  }, 20_000);

  test("export without --dir is a UsageError (exit 2)", async () => {
    const r = await runCli(["export"], envA);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--dir");
  }, 20_000);

  test("export --tag filters documents", async () => {
    const r = await runCli(["export", "--tag", "技術/検索", "--dir", tagExportDir, "--json"], envA);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ exported: 1, dir: tagExportDir });
    expect(existsSync(join(tagExportDir, "main", "日本語トークナイザー Vaporetto.md"))).toBe(true);
    expect(existsSync(join(tagExportDir, "main", "SQLite の WAL モード.md"))).toBe(false);
  }, 20_000);

  test("import: into another KURA_HOME with kura_key round-trip", async () => {
    const first = await runCli(["import", exportDir], envB);
    // Skips report their reason on stderr (checked first to diagnose failures)
    expect(first.stderr).toBe("");
    expect(first.code).toBe(0);
    expect(first.stdout).toContain("imported: 3 created, 0 updated, 0 skipped");

    // Re-importing the same export updates every document via matching kura_key
    const second = await runCli(["import", exportDir], envB);
    expect(second.stderr).toBe("");
    expect(second.code).toBe(0);
    expect(second.stdout).toContain("imported: 0 created, 3 updated, 0 skipped");

    // kura_key survives a re-export
    const reExportDir = join(work, "export2");
    const r = await runCli(["export", "--dir", reExportDir], envB);
    expect(r.code).toBe(0);
    const keyOf = (path: string): string =>
      readFileSync(path, "utf-8").match(/^kura_key: (\S+)$/m)?.[1] ?? "";
    const name = "SQLite の WAL モード.md";
    expect(keyOf(join(reExportDir, "main", name))).toBe(keyOf(join(exportDir, "main", name)));
  }, 30_000);

  test("import: skips invalid frontmatter and continues", async () => {
    const mixedDir = join(work, "mixed");
    mkdirSync(mixedDir, { recursive: true });
    const badPath = join(mixedDir, "bad.md");
    writeFileSync(badPath, "---\ntitle: [壊れた\n---\n\n不正な frontmatter の本文。\n");
    writeFileSync(
      join(mixedDir, "good.md"),
      "---\ntitle: 追加ドキュメント\ntags: [運用/メモ]\n---\n\n正常に取り込まれる日本語ドキュメント。\n",
    );

    const r = await runCli(["import", mixedDir], envA);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("imported: 1 created, 0 updated, 1 skipped");
    expect(r.stderr).toContain(`skip ${badPath}`);

    // Duplicate titles without kura_key (ConflictError) are also skipped; exit 1 when all fail
    const again = await runCli(["import", join(mixedDir, "good.md")], envA);
    expect(again.code).toBe(1);
    expect(again.stdout).toContain("imported: 0 created, 0 updated, 1 skipped");
    expect(again.stderr).toContain("already exists");
  }, 30_000);

  test("export/import round-trips document paths as directories", async () => {
    const add = await runCli(
      ["add", "-", "--title", "ベクトル検索の記事", "--path", "クリップ/技術"],
      envA,
      "リランキング前段の候補生成について。\n",
    );
    expect(add.code).toBe(0);

    const pathExportDir = join(work, "export-paths");
    const r = await runCli(["export", "--dir", pathExportDir], envA);
    expect(r.code).toBe(0);
    const filePath = join(pathExportDir, "main", "クリップ", "技術", "ベクトル検索の記事.md");
    expect(existsSync(filePath)).toBe(true);
    expect(readFileSync(filePath, "utf-8")).toContain('path: "クリップ/技術"');

    // Frontmatter path wins on import into another home
    const imp = await runCli(["import", pathExportDir], envB);
    expect(imp.code).toBe(0);
    const ls = await runCli(["ls", "--prefix", "クリップ", "--json"], envB);
    const docs = JSON.parse(ls.stdout) as Array<{ path: string; title: string }>;
    expect(docs.length).toBe(1);
    expect(docs[0]?.path).toBe("クリップ/技術");
  }, 30_000);

  test("import derives paths from subdirectories when frontmatter has none", async () => {
    const treeDir = join(work, "tree");
    mkdirSync(join(treeDir, "調査", "検索"), { recursive: true });
    writeFileSync(
      join(treeDir, "調査", "検索", "リランキング手法.md"),
      "クロスエンコーダによる再順位付けのメモ。\n",
    );
    const r = await runCli(["import", treeDir], envA);
    expect(r.code).toBe(0);
    const ls = await runCli(["ls", "--prefix", "調査/検索", "--json"], envA);
    const docs = JSON.parse(ls.stdout) as Array<{ path: string; title: string }>;
    expect(docs.length).toBe(1);
    expect(docs[0]?.title).toBe("リランキング手法");
    expect(docs[0]?.path).toBe("調査/検索");
  }, 30_000);

  test("bucket: add / ls / mv", async () => {
    const add = await runCli(["bucket", "add", "notes", "--desc", "メモ用"], envA);
    expect(add.code).toBe(0);
    expect(add.stdout).toContain("created bucket notes");

    const ls = await runCli(["bucket", "ls", "--json"], envA);
    expect(ls.code).toBe(0);
    const buckets = JSON.parse(ls.stdout) as Array<{
      name: string;
      description: string | null;
      documents: number;
      created_at: string;
    }>;
    const notes = buckets.find((b) => b.name === "notes");
    expect(notes).toMatchObject({ name: "notes", description: "メモ用", documents: 0 });

    const plain = await runCli(["bucket", "ls"], envA);
    expect(plain.code).toBe(0);
    expect(plain.stdout).toContain("notes  0 documents  メモ用");

    const mv = await runCli(["bucket", "mv", "notes", "notes2"], envA);
    expect(mv.code).toBe(0);
    expect(mv.stdout).toContain("renamed bucket notes -> notes2");
    const after = await runCli(["bucket", "ls", "--json"], envA);
    const names = (JSON.parse(after.stdout) as Array<{ name: string }>).map((b) => b.name);
    expect(names).toContain("notes2");
    expect(names).not.toContain("notes");
  }, 30_000);

  test("bucket rm: fails when non-empty, deletes with --force, refuses the default bucket", async () => {
    const docPath = join(work, "議事録.md");
    writeFileSync(docPath, "---\ntitle: 定例会議の議事録\n---\n\n次回までの宿題を確認した。\n");
    const imp = await runCli(["import", docPath, "--bucket", "notes2"], envA);
    expect(imp.code).toBe(0);
    expect(imp.stdout).toContain("1 created");

    const rm = await runCli(["bucket", "rm", "notes2"], envA);
    expect(rm.code).toBe(1);
    expect(rm.stderr).toContain("not empty");

    const forced = await runCli(["bucket", "rm", "notes2", "--force"], envA);
    expect(forced.code).toBe(0);
    expect(forced.stdout).toContain("deleted bucket notes2 (1 documents)");

    const main = await runCli(["bucket", "rm", "main"], envA);
    expect(main.code).toBe(2);
    expect(main.stderr).toContain("cannot delete the default bucket");
  }, 30_000);
});
