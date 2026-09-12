#!/usr/bin/env bun
/** Reproducible 10k-document local benchmark (docs: performance.md). */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openDatabase } from "../src/core/db";
import {
  createDocument,
  deleteDocument,
  getDocumentByKey,
  updateDocument,
} from "../src/core/documents";
import { keywordSearch } from "../src/core/search/keyword";

interface Distribution {
  medianMs: number;
  p90Ms: number;
}

interface BenchmarkResult {
  schemaVersion: 1;
  label: string;
  revision: string;
  environment: {
    platform: string;
    arch: string;
    cpu: string;
    bunVersion: string;
    tokenizer: "trigram";
    documents: number;
    warmupRuns: number;
    timedRuns: number;
    crudBatchSize: number;
  };
  metrics: {
    ingest: Distribution & { meanMsPerDocument: number; totalMs: number };
    keyword: Record<string, Distribution>;
    crud: {
      create: Distribution;
      read: Distribution;
      update: Distribution;
      delete: Distribution;
    };
    startup: Distribution;
    databaseBytes: number;
    binaryBytes: number;
    chunks: number;
  };
  targets: {
    keywordMs: number;
    addMs: number;
    startupMs: number;
    binaryBytes: number;
    liveVsearch: "unverified-no-live-provider";
    liveQuery: "unverified-no-live-provider";
  };
}

const root = join(import.meta.dir, "..");
const cli = join(root, "src", "cli", "index.ts");

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  return {
    medianMs: Number(median.toFixed(3)),
    p90Ms: Number(sorted[Math.ceil(sorted.length * 0.9) - 1]!.toFixed(3)),
  };
}

function timed<T>(fn: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = fn();
  return { value, ms: performance.now() - start };
}

function bodyFor(index: number): string {
  const suffix = String(index).padStart(5, "0");
  const topics: Array<[string, string]> = [
    ["全文検索", "日本語の全文検索と検索品質を同じ条件で検証します。"],
    ["トランザクション", "SQLiteのトランザクションと整合性をローカル環境で確認します。"],
    ["形態素解析", "形態素解析とtrigramの検索結果を再現可能なデータで比較します。"],
    ["性能測定", "起動時間とCRUD性能とデータベースサイズを継続的に記録します。"],
    ["運用設計", "ローカル動作と縮退時の契約を同じ入力で継続的に確認します。"],
  ];
  const [heading, text] = topics[index % topics.length]!;
  return `## ${heading}\n\n${text.repeat(16)}\n\n## 運用メモ\n\n文書番号${suffix}の計測条件を保存し、外部モデルは利用しません。`;
}

function runCli(home: string, dbPath: string, args: string[]): number {
  const proc = Bun.spawnSync([process.execPath, "run", cli, ...args], {
    cwd: root,
    env: { ...process.env, KURA_HOME: home, KURA_DB: dbPath, NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(proc.stderr).trim() || `CLI exit ${proc.exitCode}`);
  }
  return proc.exitCode;
}

function runBenchmark(options: {
  label: string;
  revision: string;
  binary: string;
  output: string;
  documents: number;
  warmupRuns: number;
  timedRuns: number;
  keepTemp: boolean;
}): BenchmarkResult {
  if (!existsSync(options.binary)) throw new Error(`binary not found: ${options.binary}`);
  const home = mkdtempSync(join(tmpdir(), `kura-benchmark-${options.label}-`));
  const dbPath = join(home, "kura.db");
  process.env.KURA_HOME = home;
  process.env.KURA_DB = dbPath;

  const ingestTimes: number[] = [];
  try {
    const { db, tokenizer } = openDatabase({
      path: dbPath,
      vaporettoPath: null,
      dimensions: 4,
      embeddingModel: "benchmark-none",
    });
    if (tokenizer !== "trigram") throw new Error(`expected trigram, got ${tokenizer}`);

    for (let i = 0; i < options.documents; i++) {
      const { ms } = timed(() =>
        createDocument(db, {
          docKey: i.toString(16).padStart(8, "0"),
          title: `技術メモ ${String(i).padStart(5, "0")}`,
          content: bodyFor(i),
          bucket: "main",
          tags: [`benchmark/topic-${i % 5}`],
        }),
      );
      ingestTimes.push(ms);
    }

    const queries = ["全文検索", "トランザクション", "形態素解析"];
    const keyword: Record<string, Distribution> = {};
    for (const query of queries) {
      for (let i = 0; i < options.warmupRuns; i++) keywordSearch(db, tokenizer, query);
      const values = Array.from(
        { length: options.timedRuns },
        () => timed(() => keywordSearch(db, tokenizer, query)).ms,
      );
      keyword[query] = distribution(values);
    }

    const crudBatchSize = 20;
    const crudValues = {
      create: [] as number[],
      read: [] as number[],
      update: [] as number[],
      delete: [] as number[],
    };
    const crudCycle = (index: number) => {
      const key = (0xf0000000 + index).toString(16);
      const created = timed(() =>
        createDocument(db, {
          docKey: key,
          title: `CRUD検証 ${index}`,
          content: "日本語の作成検証本文。",
          bucket: "main",
          tags: ["benchmark/crud"],
        }),
      );
      const read = timed(() => getDocumentByKey(db, key));
      const update = timed(() =>
        updateDocument(db, created.value.id, { content: "日本語の更新検証本文。" }),
      );
      const deleted = timed(() => deleteDocument(db, created.value.id));
      return { create: created.ms, read: read.ms, update: update.ms, delete: deleted.ms };
    };
    for (let i = 0; i < options.warmupRuns; i++) crudCycle(i);
    for (let run = 0; run < options.timedRuns; run++) {
      const sums = { create: 0, read: 0, update: 0, delete: 0 };
      for (let item = 0; item < crudBatchSize; item++) {
        const values = crudCycle(1_000 + run * crudBatchSize + item);
        for (const operation of Object.keys(sums) as Array<keyof typeof sums>) {
          sums[operation] += values[operation];
        }
      }
      for (const operation of Object.keys(sums) as Array<keyof typeof sums>) {
        crudValues[operation].push(sums[operation] / crudBatchSize);
      }
    }

    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const chunks = (db.prepare("SELECT COUNT(*) AS count FROM chunks").get() as { count: number })
      .count;
    db.close();

    for (let i = 0; i < options.warmupRuns; i++) {
      runCli(home, dbPath, ["search", "全文検索", "--json"]);
    }
    const startupValues = Array.from(
      { length: options.timedRuns },
      () => timed(() => runCli(home, dbPath, ["search", "全文検索", "--json"])).ms,
    );

    const totalMs = ingestTimes.reduce((sum, value) => sum + value, 0);
    const result: BenchmarkResult = {
      schemaVersion: 1,
      label: options.label,
      revision: options.revision,
      environment: {
        platform: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? "unknown",
        bunVersion: Bun.version,
        tokenizer: "trigram",
        documents: options.documents,
        warmupRuns: options.warmupRuns,
        timedRuns: options.timedRuns,
        crudBatchSize,
      },
      metrics: {
        ingest: {
          ...distribution(ingestTimes),
          meanMsPerDocument: Number((totalMs / ingestTimes.length).toFixed(3)),
          totalMs: Number(totalMs.toFixed(3)),
        },
        keyword,
        crud: {
          create: distribution(crudValues.create),
          read: distribution(crudValues.read),
          update: distribution(crudValues.update),
          delete: distribution(crudValues.delete),
        },
        startup: distribution(startupValues),
        databaseBytes: statSync(dbPath).size,
        binaryBytes: statSync(options.binary).size,
        chunks,
      },
      targets: {
        keywordMs: 100,
        addMs: 200,
        startupMs: 300,
        binaryBytes: 100_000_000,
        liveVsearch: "unverified-no-live-provider",
        liveQuery: "unverified-no-live-provider",
      },
    };
    writeFileSync(options.output, `${JSON.stringify(result, null, 2)}\n`);
    return result;
  } finally {
    if (!options.keepTemp) rmSync(home, { recursive: true, force: true });
    else console.error(`benchmark temp retained: ${home}`);
  }
}

function metricEntries(result: BenchmarkResult): Array<[string, number]> {
  const entries: Array<[string, number]> = [
    ["ingest.meanMsPerDocument", result.metrics.ingest.meanMsPerDocument],
    ["startup.medianMs", result.metrics.startup.medianMs],
    ["startup.p90Ms", result.metrics.startup.p90Ms],
    ["databaseBytes", result.metrics.databaseBytes],
    ["binaryBytes", result.metrics.binaryBytes],
  ];
  for (const [query, value] of Object.entries(result.metrics.keyword)) {
    entries.push(
      [`keyword.${query}.medianMs`, value.medianMs],
      [`keyword.${query}.p90Ms`, value.p90Ms],
    );
  }
  for (const [operation, value] of Object.entries(result.metrics.crud)) {
    entries.push(
      [`crud.${operation}.medianMs`, value.medianMs],
      [`crud.${operation}.p90Ms`, value.p90Ms],
    );
  }
  return entries;
}

function compareResults(baselinePaths: string[], finalPaths: string[], output: string): number {
  const baselines = baselinePaths.map(
    (path) => JSON.parse(readFileSync(path, "utf8")) as BenchmarkResult,
  );
  const finals = finalPaths.map(
    (path) => JSON.parse(readFileSync(path, "utf8")) as BenchmarkResult,
  );
  if (baselines.length !== finals.length) throw new Error("baseline/final trial counts differ");
  const baseline = baselines[0]!;
  const final = finals[0]!;
  const comparable = [
    "platform",
    "arch",
    "cpu",
    "bunVersion",
    "tokenizer",
    "documents",
    "warmupRuns",
    "timedRuns",
    "crudBatchSize",
  ] as const;
  for (const result of [...baselines, ...finals]) {
    for (const key of comparable) {
      if (baseline.environment[key] !== result.environment[key]) {
        throw new Error(`environment mismatch for ${key}`);
      }
    }
    if (baseline.metrics.chunks !== result.metrics.chunks)
      throw new Error("fixture chunk count differs");
  }

  const trialMaps = (results: BenchmarkResult[]) =>
    results.map((result) => new Map(metricEntries(result)));
  const baselineMaps = trialMaps(baselines);
  const finalMaps = trialMaps(finals);
  const metrics = metricEntries(baseline).map(([name]) => {
    const baselineTrials = baselineMaps.map((metrics) => metrics.get(name)!);
    const finalTrials = finalMaps.map((metrics) => metrics.get(name)!);
    const before = distribution(baselineTrials).medianMs;
    const after = distribution(finalTrials).medianMs;
    const deltaPercent =
      before === 0 ? null : Number((((after - before) / before) * 100).toFixed(2));
    return { name, baseline: before, final: after, deltaPercent, baselineTrials, finalTrials };
  });
  const observations = metrics.filter(
    (metric) => metric.deltaPercent !== null && metric.deltaPercent >= 10,
  );
  const regressions = observations.filter((metric) => {
    if (!metric.name.endsWith(".medianMs") && !metric.name.endsWith(".p90Ms")) return true;
    if (!metric.name.endsWith(".medianMs")) return false;
    const peer = metrics.find(
      (candidate) => candidate.name === metric.name.replace(/\.medianMs$/, ".p90Ms"),
    );
    return (
      peer?.deltaPercent !== null && peer?.deltaPercent !== undefined && peer.deltaPercent >= 10
    );
  });
  const comparison = {
    schemaVersion: 1,
    aggregation: "median-of-trials",
    regressionPolicy:
      "scalar >=10%; latency distribution requires both median and p90 >=10% (single-statistic changes remain observations)",
    baseline: { revision: baseline.revision, trials: baselines.length },
    final: { revision: final.revision, trials: finals.length },
    environment: final.environment,
    metrics,
    observations,
    regressions,
    liveProvider: {
      vsearch: "unverified-no-live-provider",
      query: "unverified-no-live-provider",
    },
  };
  writeFileSync(output, `${JSON.stringify(comparison, null, 2)}\n`);
  console.log(JSON.stringify(comparison, null, 2));
  return regressions.length === 0 ? 0 : 2;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      label: { type: "string" },
      revision: { type: "string" },
      binary: { type: "string" },
      output: { type: "string" },
      documents: { type: "string", default: "10000" },
      warmup: { type: "string", default: "3" },
      runs: { type: "string", default: "10" },
      "keep-temp": { type: "boolean", default: false },
      "baseline-result": { type: "string", multiple: true },
      "final-result": { type: "string", multiple: true },
    },
  });
  const output = values.output;
  if (!output) throw new Error("--output is required");
  if (values["baseline-result"] || values["final-result"]) {
    if (!values["baseline-result"] || !values["final-result"]) {
      throw new Error("--baseline-result and --final-result are both required");
    }
    process.exitCode = compareResults(values["baseline-result"], values["final-result"], output);
  } else {
    if (!values.label || !values.revision || !values.binary) {
      throw new Error("--label, --revision, --binary, and --output are required");
    }
    const documents = Number(values.documents);
    const warmupRuns = Number(values.warmup);
    const timedRuns = Number(values.runs);
    if (!Number.isInteger(documents) || documents < 1) throw new Error("--documents must be >= 1");
    if (!Number.isInteger(warmupRuns) || warmupRuns < 1) throw new Error("--warmup must be >= 1");
    if (!Number.isInteger(timedRuns) || timedRuns < 2) throw new Error("--runs must be >= 2");
    const result = runBenchmark({
      label: values.label,
      revision: values.revision,
      binary: values.binary,
      output,
      documents,
      warmupRuns,
      timedRuns,
      keepTemp: values["keep-temp"],
    });
    console.log(JSON.stringify(result, null, 2));
  }
}
