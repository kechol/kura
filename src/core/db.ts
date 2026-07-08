import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { VAPORETTO_ENTRY_POINT, vaporettoLibPath, vecLoadablePath } from "./bootstrap";
import { loadConfig } from "./config";
import migration001 from "./migrations/001_init.sql" with { type: "text" };
import { dbPath } from "./paths";

export type FtsTokenizer = "vaporetto" | "trigram";

/** macOS の Homebrew SQLite パス（Apple 純正 SQLite は拡張ロード不可のため必須、SPEC §2.1） */
export function brewSqlitePath(): string | null {
  if (process.platform !== "darwin") return null;
  return process.arch === "arm64"
    ? "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"
    : "/usr/local/opt/sqlite/lib/libsqlite3.dylib";
}

let sqliteConfigured = false;

/** 最初の Database 生成前に必ず呼ぶこと。macOS 以外・2回目以降は no-op */
export function setupSqlite(): void {
  if (sqliteConfigured) return;
  sqliteConfigured = true;
  if (process.platform !== "darwin") return;
  const path = brewSqlitePath();
  if (path && existsSync(path)) {
    Database.setCustomSQLite(path);
  }
}

export interface MigrateContext {
  tokenizer: FtsTokenizer;
  dimensions: number;
}

const MIGRATIONS: Array<{ version: number; render(ctx: MigrateContext): string }> = [
  {
    version: 1,
    render: (ctx) =>
      migration001
        .replaceAll("{{FTS_TOKENIZE}}", ctx.tokenizer)
        .replaceAll("{{VEC_DIMENSIONS}}", String(ctx.dimensions)),
  },
];

export function schemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/** PRAGMA user_version ベースのマイグレーションランナー（各マイグレーションはトランザクション内で適用） */
export function migrate(db: Database, ctx: MigrateContext): void {
  let current = schemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.render(ctx));
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    current = m.version;
  }
}

export function getMeta(db: Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as {
    value: string;
  } | null;
  return row?.value ?? null;
}

export function setMeta(db: Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export interface OpenOptions {
  path?: string;
  /** undefined なら bootstrap の既定パスを探す。null で明示的に無効化（テスト用） */
  vaporettoPath?: string | null;
  dimensions?: number;
  embeddingModel?: string;
}

export interface OpenResult {
  db: Database;
  tokenizer: FtsTokenizer;
  vaporettoLoaded: boolean;
  warnings: string[];
}

/**
 * DB を開き、拡張ロード → マイグレーション → meta 整合を行う。
 * 新規 DB では vaporetto ロード可否で FTS トークナイザーを決定し meta に記録する（SPEC §2.1）。
 */
export function openDatabase(opts: OpenOptions = {}): OpenResult {
  setupSqlite();
  const path = opts.path ?? dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  const warnings: string[] = [];

  // sqlite-vec は必須（chunks_vec の作成・検索に使用）
  try {
    db.loadExtension(vecLoadablePath());
  } catch (e) {
    db.close();
    const hint =
      process.platform === "darwin"
        ? "\nHomebrew SQLite が必要です: brew install sqlite（詳細は kura doctor）"
        : "\nkura doctor で診断してください";
    throw new Error(
      `failed to load sqlite-vec extension: ${e instanceof Error ? e.message : e}${hint}`,
    );
  }

  // sqlite-vaporetto は任意（無ければ trigram フォールバック）
  let vaporettoLoaded = false;
  const vapPath = opts.vaporettoPath === undefined ? vaporettoLibPath() : opts.vaporettoPath;
  if (vapPath && existsSync(vapPath)) {
    try {
      db.loadExtension(vapPath, VAPORETTO_ENTRY_POINT);
      vaporettoLoaded = true;
    } catch (e) {
      warnings.push(
        `sqlite-vaporetto のロードに失敗しました（${e instanceof Error ? e.message : e}）。trigram にフォールバックします`,
      );
    }
  }

  const config = loadConfig();
  const dimensions = opts.dimensions ?? config.llm.models.embedding_dimensions;
  const fresh = schemaVersion(db) === 0;
  let tokenizer: FtsTokenizer;

  if (fresh) {
    tokenizer = vaporettoLoaded ? "vaporetto" : "trigram";
    migrate(db, { tokenizer, dimensions });
    setMeta(db, "fts_tokenizer", tokenizer);
    setMeta(db, "embedding_model", opts.embeddingModel ?? config.llm.models.embedding);
    setMeta(db, "embedding_dimensions", String(dimensions));
  } else {
    tokenizer = (getMeta(db, "fts_tokenizer") as FtsTokenizer | null) ?? "trigram";
    migrate(db, {
      tokenizer,
      dimensions: Number(getMeta(db, "embedding_dimensions") ?? dimensions),
    });
    if (tokenizer === "vaporetto" && !vaporettoLoaded) {
      warnings.push(
        "この DB は vaporetto トークナイザーで構築されていますが拡張をロードできません。検索が失敗する場合は kura doctor を実行してください",
      );
    }
  }

  return { db, tokenizer, vaporettoLoaded, warnings };
}

let opened: OpenResult | null = null;

/**
 * CLI コマンド用のシングルトン接続。DB 未初期化（ファイルなし）なら kura init を案内して例外。
 * `KURA_DB=:memory:` のときは常に新規作成を許可（テスト用）。
 */
export function getDb(): OpenResult {
  if (opened) return opened;
  const path = dbPath();
  if (path !== ":memory:" && !existsSync(path)) {
    throw new Error(`database not found: ${path}\nRun 'kura init' first.`);
  }
  opened = openDatabase();
  for (const w of opened.warnings) console.error(`warning: ${w}`);
  return opened;
}

/** テスト用: シングルトン接続を閉じて破棄 */
export function closeDb(): void {
  opened?.db.close();
  opened = null;
}
