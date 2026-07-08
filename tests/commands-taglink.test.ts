import { beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/core/db";
import { createDocument } from "../src/core/documents";

const CLI = join(import.meta.dir, "..", "src", "cli", "index.ts");
const KEY_RE = /^[0-9a-f]{8}$/;

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
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

interface TestEnv {
  KURA_HOME: string;
  KURA_DB: string;
  [key: string]: string;
}

async function setupHome(prefix: string): Promise<TestEnv> {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const env: TestEnv = { KURA_HOME: home, KURA_DB: join(home, "kura.db") };
  const r = await runCli(["init", "--no-download"], env);
  if (r.code !== 0) throw new Error(`kura init failed: ${r.stderr}`);
  return env;
}

function titleExists(env: TestEnv, title: string): boolean {
  const { db } = openDatabase({ path: env.KURA_DB, vaporettoPath: null });
  try {
    return db.prepare("SELECT 1 FROM documents WHERE title = ?").get(title) !== null;
  } finally {
    db.close();
  }
}

/** ドキュメント投入手段。add / import が並行実装中のため、動くものを検出して使う */
type AddMode = "add" | "import" | "direct";
let addMode: AddMode = "direct";

async function detectAddMode(): Promise<AddMode> {
  const env = await setupHome("kura-taglink-probe-");
  const addFile = join(env.KURA_HOME, "プローブ文書.md");
  await Bun.write(addFile, "プローブ本文。");
  const viaAdd = await runCli(["add", addFile, "--title", "プローブ文書", "--bucket", "main"], env);
  if (viaAdd.code === 0 && titleExists(env, "プローブ文書")) return "add";

  const importFile = join(env.KURA_HOME, "プローブ文書2.md");
  await Bun.write(importFile, '---\ntitle: "プローブ文書2"\nbucket: main\n---\nプローブ本文2。\n');
  const viaImport = await runCli(["import", importFile], env);
  if (viaImport.code === 0 && titleExists(env, "プローブ文書2")) return "import";

  return "direct";
}

interface DocInput {
  title: string;
  content: string;
  bucket?: string;
}

async function addDoc(env: TestEnv, doc: DocInput): Promise<void> {
  const bucket = doc.bucket ?? "main";
  if (addMode === "direct") {
    const { db } = openDatabase({ path: env.KURA_DB, vaporettoPath: null });
    try {
      createDocument(db, { title: doc.title, content: doc.content, bucket });
    } finally {
      db.close();
    }
    return;
  }
  const dir = join(env.KURA_HOME, "docs");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${doc.title}.md`);
  let result: CliResult;
  if (addMode === "add") {
    await Bun.write(file, doc.content);
    result = await runCli(["add", file, "--title", doc.title, "--bucket", bucket], env);
  } else {
    const fm = `---\ntitle: ${JSON.stringify(doc.title)}\nbucket: ${bucket}\n---\n`;
    await Bun.write(file, `${fm}${doc.content}\n`);
    result = await runCli(["import", file], env);
  }
  if (result.code !== 0 || !titleExists(env, doc.title)) {
    throw new Error(`failed to add '${doc.title}' via kura ${addMode}: ${result.stderr}`);
  }
}

beforeAll(async () => {
  addMode = await detectAddMode();
});

describe("kura tag ls (e2e)", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await setupHome("kura-tag-ls-test-");
    await addDoc(env, {
      title: "SQLiteの基礎",
      content: "#技術/データベース/sqlite と #技術/データベース についての解説。",
    });
    await addDoc(env, { title: "PostgreSQLメモ", content: "#技術/データベース の運用メモ。" });
    await addDoc(env, { title: "読書記録", content: "#趣味/読書 の記録。" });
  });

  test("path 昇順で件数付き一覧を表示する", async () => {
    const r = await runCli(["tag", "ls"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("技術/データベース  2\n技術/データベース/sqlite  1\n趣味/読書  1\n");
  }, 30_000);

  test("--tree で中間ノードを含む階層表示をする", async () => {
    const r = await runCli(["tag", "ls", "--tree"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("技術 (3)\n  データベース (3)\n    sqlite (1)\n趣味 (1)\n  読書 (1)\n");
  }, 30_000);

  test("--json は [{path, count}] を返す", async () => {
    const r = await runCli(["tag", "ls", "--json"], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      { path: "技術/データベース", count: 2 },
      { path: "技術/データベース/sqlite", count: 1 },
      { path: "趣味/読書", count: 1 },
    ]);
  }, 30_000);

  test("--tree --json は buildTagTree の結果をそのまま返す", async () => {
    const r = await runCli(["tag", "ls", "--tree", "--json"], env);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      {
        segment: "技術",
        path: "技術",
        count: 0,
        total: 3,
        children: [
          {
            segment: "データベース",
            path: "技術/データベース",
            count: 2,
            total: 3,
            children: [
              {
                segment: "sqlite",
                path: "技術/データベース/sqlite",
                count: 1,
                total: 1,
                children: [],
              },
            ],
          },
        ],
      },
      {
        segment: "趣味",
        path: "趣味",
        count: 0,
        total: 1,
        children: [{ segment: "読書", path: "趣味/読書", count: 1, total: 1, children: [] }],
      },
    ]);
  }, 30_000);
});

describe("kura tag add/rm/mv/gc (e2e)", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await setupHome("kura-tag-ops-test-");
    await addDoc(env, { title: "設計メモ", content: "#メモ 設計についての記録。" });
    await addDoc(env, {
      title: "DBノート",
      content: "#旧分類/データベース と #旧分類/データベース/索引 の説明。",
    });
    await addDoc(env, { title: "アーキ記事", content: "#技術/データベース を参照。" });
  });

  test("add: 新規タグを付与し、全部重複なら no tags added", async () => {
    const first = await runCli(["tag", "add", "設計メモ", "技術/アーキテクチャ", "重要"], env);
    expect(first.code).toBe(0);
    expect(first.stdout).toBe("added: 技術/アーキテクチャ, 重要\n");

    const dup = await runCli(["tag", "add", "設計メモ", "重要", "--bucket", "main"], env);
    expect(dup.code).toBe(0);
    expect(dup.stdout).toBe("no tags added\n");

    const mixed = await runCli(["tag", "add", "設計メモ", "重要", "レビュー済"], env);
    expect(mixed.code).toBe(0);
    expect(mixed.stdout).toBe("added: レビュー済\n");
  }, 30_000);

  test("rm: 付いているタグだけ外れる", async () => {
    const r = await runCli(["tag", "rm", "設計メモ", "重要", "メモ", "レビュー済"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("removed 3 tags\n");

    const again = await runCli(["tag", "rm", "設計メモ", "重要"], env);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("removed 0 tags\n");
  }, 30_000);

  test("mv: リネームと、子孫込みの移動 + 既存タグへの merge", async () => {
    const rename = await runCli(["tag", "mv", "技術/アーキテクチャ", "技術/設計"], env);
    expect(rename.code).toBe(0);
    expect(rename.stdout).toBe("moved 1 tags\n");

    // 旧分類/データベース は既存の 技術/データベース へ merge、子孫 索引 は付いて移動する
    const merge = await runCli(["tag", "mv", "旧分類", "技術"], env);
    expect(merge.code).toBe(0);
    expect(merge.stdout).toBe("moved 2 tags (merged into existing)\n");

    const ls = await runCli(["tag", "ls", "--json"], env);
    expect(JSON.parse(ls.stdout)).toEqual([
      { path: "メモ", count: 0 },
      { path: "レビュー済", count: 0 },
      { path: "技術/データベース", count: 2 },
      { path: "技術/データベース/索引", count: 1 },
      { path: "技術/設計", count: 1 },
      { path: "重要", count: 0 },
    ]);
  }, 30_000);

  test("gc: 孤立タグを削除し、2回目は no orphan tags", async () => {
    const r = await runCli(["tag", "gc"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("removed 3 orphan tags: メモ, レビュー済, 重要\n");

    const again = await runCli(["tag", "gc"], env);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("no orphan tags\n");
  }, 30_000);

  test("suggest は --doc / --untagged なしで exit 2", async () => {
    const suggest = await runCli(["tag", "suggest"], env);
    expect(suggest.code).toBe(2);
    expect(suggest.stderr).toContain("--doc <doc> or --untagged");
  }, 30_000);
});

describe("kura link (e2e)", () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await setupHome("kura-link-test-");
    await addDoc(env, { title: "インデックス戦略", content: "インデックスの張り方について。" });
    await addDoc(env, { title: "正規化", content: "第三正規形までの設計。" });
    await addDoc(env, {
      title: "データベース設計",
      content: "[[インデックス戦略]] と [[正規化]] を踏まえた設計方針。",
    });
    await addDoc(env, { title: "クエリ最適化", content: "[[インデックス戦略]] を活用する。" });
    await addDoc(env, { title: "設計レビュー", content: "[[データベース設計]] のレビュー記録。" });
    await addDoc(env, { title: "未来ノート", content: "[[まだ無い記事]] を書く予定。" });
  });

  test("ls: outlinks / backlinks / 2-hop の 3 セクションを表示する", async () => {
    const r = await runCli(["link", "ls", "データベース設計"], env);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^outlinks:\n/);
    expect(r.stdout).toMatch(/ {2}\[\[インデックス戦略\]\] -> #[0-9a-f]{8} \(main\)\n/);
    expect(r.stdout).toMatch(/ {2}\[\[正規化\]\] -> #[0-9a-f]{8} \(main\)\n/);
    expect(r.stdout).toMatch(/backlinks:\n {2}#[0-9a-f]{8} 設計レビュー \(main\)\n/);
    expect(r.stdout).toMatch(
      /2-hop \(via インデックス戦略\):\n {2}#[0-9a-f]{8} クエリ最適化 \(main\)\n/,
    );
    expect(r.stdout).not.toContain("(none)");
  }, 30_000);

  test("ls --json: {outlinks, backlinks, twoHop} を返す", async () => {
    const r = await runCli(["link", "ls", "データベース設計", "--bucket", "main", "--json"], env);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j.outlinks).toEqual([
      {
        target_title: "インデックス戦略",
        key: expect.stringMatching(KEY_RE),
        title: "インデックス戦略",
        bucket: "main",
      },
      {
        target_title: "正規化",
        key: expect.stringMatching(KEY_RE),
        title: "正規化",
        bucket: "main",
      },
    ]);
    expect(j.backlinks).toEqual([
      { key: expect.stringMatching(KEY_RE), title: "設計レビュー", bucket: "main" },
    ]);
    expect(j.twoHop).toEqual([
      {
        via: { key: expect.stringMatching(KEY_RE), title: "インデックス戦略", bucket: "main" },
        docs: [{ key: expect.stringMatching(KEY_RE), title: "クエリ最適化", bucket: "main" }],
      },
    ]);
    // 2-hop の共通リンク先はアウトリンク先と同一ドキュメント
    expect(j.twoHop[0].via.key).toBe(j.outlinks[0].key);
  }, 30_000);

  test("ls: 空セクションは (none)、未解決リンクは (unresolved)", async () => {
    const normalized = await runCli(["link", "ls", "正規化"], env);
    expect(normalized.code).toBe(0);
    expect(normalized.stdout).toContain("outlinks:\n  (none)\n");
    expect(normalized.stdout).toMatch(/backlinks:\n {2}#[0-9a-f]{8} データベース設計 \(main\)\n/);
    expect(normalized.stdout).toContain("2-hop:\n  (none)\n");

    const future = await runCli(["link", "ls", "未来ノート"], env);
    expect(future.code).toBe(0);
    expect(future.stdout).toContain("  [[まだ無い記事]] -> (unresolved)\n");
    expect(future.stdout).toContain("backlinks:\n  (none)\n");
    expect(future.stdout).toContain("2-hop:\n  (none)\n");
  }, 30_000);

  test("broken: 未解決リンクを表示し、リンク先の追加で自動解決される (SPEC §10.1)", async () => {
    const before = await runCli(["link", "broken"], env);
    expect(before.code).toBe(0);
    expect(before.stdout).toMatch(/^\[\[まだ無い記事\]\] <- #[0-9a-f]{8} 未来ノート \(main\)\n$/);

    const jsonBefore = await runCli(["link", "broken", "--bucket", "main", "--json"], env);
    expect(jsonBefore.code).toBe(0);
    expect(JSON.parse(jsonBefore.stdout)).toEqual([
      {
        target_title: "まだ無い記事",
        sources: [{ key: expect.stringMatching(KEY_RE), title: "未来ノート", bucket: "main" }],
      },
    ]);

    const badBucket = await runCli(["link", "broken", "--bucket", "nonexistent"], env);
    expect(badBucket.code).toBe(3);

    // リンク先を作成すると未解決リンクが自動解決される
    await addDoc(env, { title: "まだ無い記事", content: "追記予定。" });
    const after = await runCli(["link", "broken"], env);
    expect(after.code).toBe(0);
    expect(after.stdout).toBe("no broken links\n");

    const resolved = await runCli(["link", "ls", "未来ノート"], env);
    expect(resolved.stdout).toMatch(/ {2}\[\[まだ無い記事\]\] -> #[0-9a-f]{8} \(main\)\n/);
  }, 30_000);
});
