import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { VAPORETTO_ENTRY_POINT, vaporettoLibPath, vecLoadablePath } from "./bootstrap";
import { loadConfig } from "./config";
import migration001 from "./migrations/001_init.sql" with { type: "text" };
import migration002 from "./migrations/002_document_paths.sql" with { type: "text" };
import migration003 from "./migrations/003_favorites.sql" with { type: "text" };
import migration004 from "./migrations/004_aliases.sql" with { type: "text" };
import migration005 from "./migrations/005_revisions.sql" with { type: "text" };
import { dbPath } from "./paths";

export type FtsTokenizer = "vaporetto" | "trigram";

/** Homebrew SQLite path on macOS (required because Apple's bundled SQLite cannot load extensions, docs: native-extensions.md) */
export function brewSqlitePath(): string | null {
  if (process.platform !== "darwin") return null;
  return process.arch === "arm64"
    ? "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib"
    : "/usr/local/opt/sqlite/lib/libsqlite3.dylib";
}

let sqliteConfigured = false;

/** Must be called before the first Database is created. No-op on non-macOS and on repeat calls */
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
  {
    version: 2,
    render: () => migration002,
  },
  {
    version: 3,
    render: () => migration003,
  },
  {
    version: 4,
    render: (ctx) => migration004.replaceAll("{{FTS_TOKENIZE}}", ctx.tokenizer),
  },
  {
    version: 5,
    render: () => migration005,
  },
];

export function schemaVersion(db: Database): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * PRAGMA user_version based migration runner (each migration is applied inside a transaction).
 * `upTo` caps the target version (tests build old-schema databases with it).
 *
 * foreign_keys is toggled off around each migration — the pragma is a no-op
 * inside a transaction, and a table rebuild's DROP TABLE would otherwise fire
 * ON DELETE actions on the child tables. foreign_key_check before COMMIT keeps
 * the safety the pragma provided (sqlite.org/lang_altertable.html §7).
 */
export function migrate(db: Database, ctx: MigrateContext, upTo = Number.MAX_SAFE_INTEGER): void {
  let current = schemaVersion(db);
  for (const m of MIGRATIONS) {
    if (m.version <= current || m.version > upTo) continue;
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    try {
      db.exec(m.render(ctx));
      const violations = db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error(
          `migration ${m.version}: foreign_key_check reported ${violations.length} violation(s)`,
        );
      }
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
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
  /** undefined: look up the default bootstrap path. null: explicitly disable (for tests) */
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
 * Open the database: load extensions, run migrations, and reconcile meta.
 * For a fresh DB, pick the FTS tokenizer based on whether vaporetto loaded and record it in meta (docs: native-extensions.md).
 */
export function openDatabase(opts: OpenOptions = {}): OpenResult {
  setupSqlite();
  const path = opts.path ?? dbPath();
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  // Wait, don't immediately error, when another connection holds the write
  // lock (e.g. the MCP server running alongside a CLI write, or rapid
  // successive commands). 15s absorbs transient WAL contention on slow /
  // loaded filesystems where 5s occasionally surfaced "database is locked".
  db.exec("PRAGMA busy_timeout = 15000");

  const warnings: string[] = [];

  // sqlite-vec is required (used to create and query chunks_vec)
  try {
    db.loadExtension(vecLoadablePath());
  } catch (e) {
    db.close();
    const hint =
      process.platform === "darwin"
        ? "\nHomebrew SQLite is required: brew install sqlite (see kura doctor for details)"
        : "\nRun kura doctor to diagnose";
    throw new Error(
      `failed to load sqlite-vec extension: ${e instanceof Error ? e.message : e}${hint}`,
    );
  }

  // sqlite-vaporetto is optional (falls back to trigram when unavailable)
  let vaporettoLoaded = false;
  const vapPath = opts.vaporettoPath === undefined ? vaporettoLibPath() : opts.vaporettoPath;
  if (vapPath && existsSync(vapPath)) {
    try {
      db.loadExtension(vapPath, VAPORETTO_ENTRY_POINT);
      vaporettoLoaded = true;
    } catch (e) {
      warnings.push(
        `failed to load sqlite-vaporetto (${e instanceof Error ? e.message : e}); falling back to trigram`,
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
        "this database was built with the vaporetto tokenizer but the extension could not be loaded. If searches fail, run kura doctor",
      );
    }
  }

  return { db, tokenizer, vaporettoLoaded, warnings };
}

let opened: OpenResult | null = null;

/**
 * Singleton connection for CLI commands. Throws with a hint to run kura init when the DB file does not exist.
 * `KURA_DB=:memory:` always allows fresh creation (for tests).
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

/** For tests: close and discard the singleton connection */
export function closeDb(): void {
  opened?.db.close();
  opened = null;
}
