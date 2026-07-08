import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import {
  VAPORETTO_ENTRY_POINT,
  vaporettoLibPath,
  vaporettoSupported,
  vecLoadablePath,
} from "../../core/bootstrap";
import { type KuraConfig, loadConfig } from "../../core/config";
import { brewSqlitePath, getMeta, openDatabase, schemaVersion, setupSqlite } from "../../core/db";
import { configPath, dbPath, kuraHome } from "../../core/paths";
import { EXIT, parseCommandArgs } from "../args";

export const summary = "Diagnose installation and environment";

export const usage = `Usage: kura doctor [--fix]

Checks SQLite / native extensions / database integrity / LLM providers.

Options:
  --fix   修復を実行: 拡張再取得 / FTS リビルド・再トークナイズ / 孤立チャンク GC /
          content_hash 再計算 / 未解決リンク再解決 / embedding 設定変更の反映`;

type Status = "ok" | "warn" | "fail";

interface Check {
  name: string;
  status: Status;
  detail: string;
}

const MARK: Record<Status, string> = { ok: "✓", warn: "⚠", fail: "✗" };

async function fetchJson(url: string, timeoutMs = 2000): Promise<unknown | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Ollama のモデル名比較（":latest" と大文字小文字を無視） */
function normalizeModelName(name: string): string {
  return name.toLowerCase().replace(/:latest$/, "");
}

function checkVec(checks: Check[]): void {
  try {
    setupSqlite();
    const db = new Database(":memory:");
    db.loadExtension(vecLoadablePath());
    const v = (db.prepare("SELECT vec_version() AS v").get() as { v: string }).v;
    db.close();
    checks.push({ name: "sqlite-vec", status: "ok", detail: v });
  } catch (e) {
    checks.push({
      name: "sqlite-vec",
      status: "fail",
      detail: `load failed: ${e instanceof Error ? e.message : e}`,
    });
  }
}

function checkVaporetto(checks: Check[]): boolean {
  if (!vaporettoSupported()) {
    checks.push({
      name: "vaporetto",
      status: "warn",
      detail: `${process.platform}-${process.arch} は未対応（trigram フォールバック）`,
    });
    return false;
  }
  const lib = vaporettoLibPath();
  if (!lib || !existsSync(lib)) {
    checks.push({
      name: "vaporetto",
      status: "warn",
      detail: "未インストール。'kura init' でダウンロードされます",
    });
    return false;
  }
  try {
    setupSqlite();
    const db = new Database(":memory:");
    db.loadExtension(lib, VAPORETTO_ENTRY_POINT);
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='vaporetto')");
    db.exec("INSERT INTO t (body) VALUES ('東京で全文検索の実験をした')");
    const hit = db
      .prepare("SELECT COUNT(*) AS n FROM t WHERE t MATCH vaporetto_or_query(?)")
      .get("全文検索") as { n: number };
    db.close();
    if (hit.n !== 1) {
      checks.push({ name: "vaporetto", status: "fail", detail: "トークナイズ検証に失敗" });
      return false;
    }
    checks.push({ name: "vaporetto", status: "ok", detail: lib });
    return true;
  } catch (e) {
    checks.push({
      name: "vaporetto",
      status: "fail",
      detail: `load failed: ${e instanceof Error ? e.message : e}`,
    });
    return false;
  }
}

function checkDatabase(checks: Check[], vaporettoOk: boolean): void {
  const path = dbPath();
  if (path !== ":memory:" && !existsSync(path)) {
    checks.push({
      name: "database",
      status: "warn",
      detail: `未作成。'kura init' を実行してください（${path}）`,
    });
    return;
  }
  try {
    const { db, tokenizer, warnings } = openDatabase();
    const version = schemaVersion(db);
    const quick = (db.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check;
    const docs = (db.prepare("SELECT COUNT(*) AS n FROM documents").get() as { n: number }).n;
    const fts = (db.prepare("SELECT COUNT(*) AS n FROM documents_fts").get() as { n: number }).n;
    const embModel = getMeta(db, "embedding_model");
    db.close();

    if (quick !== "ok") {
      checks.push({ name: "database", status: "fail", detail: `quick_check: ${quick}` });
      return;
    }
    checks.push({
      name: "database",
      status: "ok",
      detail: `${path} (schema v${version}, ${docs} documents, tokenizer: ${tokenizer})`,
    });
    if (docs !== fts) {
      checks.push({
        name: "fts-sync",
        status: "warn",
        detail: `documents=${docs} / fts=${fts} が不一致。FTS リビルドが必要です`,
      });
    }
    if (tokenizer === "trigram" && vaporettoOk) {
      checks.push({
        name: "fts-tokenizer",
        status: "warn",
        detail: "vaporetto が利用可能ですが DB は trigram で構築されています（再インデックス推奨）",
      });
    }
    const config = loadConfig();
    if (embModel && embModel !== config.llm.models.embedding) {
      checks.push({
        name: "embedding-model",
        status: "warn",
        detail: `DB=${embModel} / config=${config.llm.models.embedding} が不一致。'kura embed --all' で再生成してください`,
      });
    }
    for (const w of warnings) {
      checks.push({ name: "database", status: "warn", detail: w });
    }
  } catch (e) {
    checks.push({
      name: "database",
      status: "fail",
      detail: e instanceof Error ? e.message : String(e),
    });
  }
}

async function checkProviders(checks: Check[], config: KuraConfig): Promise<void> {
  const ollama = (await fetchJson(`${config.llm.ollama_url}/api/tags`)) as {
    models?: Array<{ name: string }>;
  } | null;
  if (ollama?.models) {
    checks.push({
      name: "ollama",
      status: "ok",
      detail: `${config.llm.ollama_url} (${ollama.models.length} models)`,
    });
    const installed = new Set(ollama.models.map((m) => normalizeModelName(m.name)));
    const required = [
      config.llm.models.embedding,
      config.llm.models.reranker,
      config.llm.models.generation,
    ];
    const missing = required.filter((m) => !installed.has(normalizeModelName(m)));
    if (missing.length > 0) {
      checks.push({
        name: "ollama-models",
        status: "warn",
        detail: `不足モデルあり: ${missing.map((m) => `ollama pull ${m}`).join(" / ")}`,
      });
    } else {
      checks.push({ name: "ollama-models", status: "ok", detail: "必要モデルすべて利用可能" });
    }
  } else {
    checks.push({
      name: "ollama",
      status: "warn",
      detail: `${config.llm.ollama_url} に到達できません`,
    });
  }

  const lmstudio = await fetchJson(`${config.llm.lmstudio_url}/v1/models`);
  checks.push(
    lmstudio
      ? { name: "lmstudio", status: "ok", detail: config.llm.lmstudio_url }
      : {
          name: "lmstudio",
          status: "warn",
          detail: `${config.llm.lmstudio_url} に到達できません`,
        },
  );

  const resolved =
    config.llm.provider !== "auto"
      ? config.llm.provider
      : ollama
        ? "ollama"
        : lmstudio
          ? "lmstudio"
          : "none";
  checks.push({
    name: "llm-provider",
    status: resolved === "none" ? "warn" : "ok",
    detail:
      resolved === "none"
        ? "利用可能なプロバイダなし（キーワード検索のみの劣化動作）"
        : `${resolved}${config.llm.provider === "auto" ? " (auto)" : ""}`,
  });
}

async function runFixes(config: KuraConfig): Promise<void> {
  const { ensureVaporetto } = await import("../../core/bootstrap");
  const {
    fixContentHashes,
    gcOrphans,
    rebuildFtsIfNeeded,
    recreateVecIfModelChanged,
    resolveAllUnresolvedLinks,
    retokenizeFts,
  } = await import("../../core/doctor");

  const reports: Array<{ action: string; detail: string }> = [];

  // 拡張再取得（対応プラットフォームで未展開のときのみダウンロード）
  if (vaporettoSupported() && !existsSync(vaporettoLibPath() ?? "")) {
    try {
      const path = await ensureVaporetto({ download: true });
      if (path) reports.push({ action: "vaporetto", detail: `拡張を取得しました: ${path}` });
    } catch (e) {
      reports.push({
        action: "vaporetto",
        detail: `拡張の取得に失敗しました（${e instanceof Error ? e.message : e}）`,
      });
    }
  }

  if (dbPath() === ":memory:" || existsSync(dbPath())) {
    const { db, tokenizer, vaporettoLoaded } = openDatabase();
    try {
      for (const fix of [
        () => recreateVecIfModelChanged(db, config),
        () => gcOrphans(db),
        () => fixContentHashes(db),
        () => rebuildFtsIfNeeded(db),
        () => resolveAllUnresolvedLinks(db),
      ]) {
        const report = fix();
        if (report) reports.push(report);
      }
      // trigram で構築された DB でも vaporetto が使えるようになったら再インデックス
      if (tokenizer === "trigram" && vaporettoLoaded) {
        reports.push(retokenizeFts(db, "vaporetto"));
      }
    } finally {
      db.close();
    }
  }

  if (reports.length === 0) {
    console.log("--fix: 修復対象はありませんでした");
  } else {
    for (const r of reports) console.log(`fixed: ${r.action.padEnd(16)} ${r.detail}`);
  }
  console.log("");
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, { fix: { type: "boolean", default: false } });
  const checks: Check[] = [];

  if (parsed.values.fix === true) {
    await runFixes(loadConfig());
  }

  checks.push({
    name: "platform",
    status: "ok",
    detail: `${process.platform}-${process.arch} / Bun ${Bun.version} / KURA_HOME: ${kuraHome()}`,
  });

  if (process.platform === "darwin") {
    const brew = brewSqlitePath();
    checks.push(
      brew && existsSync(brew)
        ? { name: "homebrew-sqlite", status: "ok", detail: brew }
        : {
            name: "homebrew-sqlite",
            status: "fail",
            detail: `${brew} が見つかりません。'brew install sqlite' を実行してください`,
          },
    );
  }

  let config: KuraConfig;
  try {
    config = loadConfig();
    checks.push({
      name: "config",
      status: "ok",
      detail: existsSync(configPath()) ? configPath() : "未作成（既定値で動作）",
    });
  } catch (e) {
    checks.push({
      name: "config",
      status: "fail",
      detail: `${configPath()} のパースに失敗: ${e instanceof Error ? e.message : e}`,
    });
    config = loadConfig(":missing:");
  }

  checkVec(checks);
  const vaporettoOk = checkVaporetto(checks);
  checkDatabase(checks, vaporettoOk);
  await checkProviders(checks, config);

  for (const c of checks) {
    console.log(`${MARK[c.status]} ${c.name.padEnd(17)} ${c.detail}`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  console.log("");
  console.log(`${checks.length} checks: ${failed} failed, ${warned} warnings`);
  return failed > 0 ? EXIT.ERROR : EXIT.OK;
}
