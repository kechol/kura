import type { Database } from "bun:sqlite";
import {
  type AuditOutcome,
  type ContradictionPair,
  findContradictions,
  pairLabel,
} from "../../core/audit";
import { requireBucket } from "../../core/buckets";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { auditDupes, type DupeDocRef, type DupesResult, mergeDuplicate } from "../../core/dedupe";
import { auditTags, type TagAuditResult } from "../../core/gardening";
import { type BrokenLink, brokenLinks, type RelatedDoc } from "../../core/links";
import { requireProvider, resolveProvider } from "../../core/llm/provider";
import { renameTag } from "../../core/tags";
import { boolOpt, EXIT, intOpt, type Parsed, parseCommandArgs, strOpt, UsageError } from "../args";
import { confirm } from "../prompt";

export const summary = "Audit the knowledge base (links, tags, dupes, contradictions)";

export const usage = `Usage: kura audit [contradictions|dupes|tags|links] [options]

Runs knowledge-base health checks. Without a subcommand, runs every
check that can run (skipping LLM-only checks when no provider is
reachable) and prints a combined report.

Options:
  --bucket <name>   Scope to this bucket
  --limit <n>       contradictions/dupes: cap the documents/pairs examined
  --apply           dupes/tags: offer to apply fixes (per-item confirmation)
  --json            Machine-readable output (never applies)`;

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    limit: { type: "string" },
    apply: { type: "boolean", default: false },
  });
  const sub = parsed.positionals[0];
  switch (sub) {
    case undefined:
      return runAll(parsed);
    case "contradictions":
      return runContradictions(parsed);
    case "dupes":
      return runDupes(parsed);
    case "tags":
      return runTags(parsed);
    case "links":
      return runLinks(parsed);
    default:
      throw new UsageError(`unknown subcommand: ${sub}`);
  }
}

// ---------------------------------------------------------------------------
// links
// ---------------------------------------------------------------------------

function linkDocLine(doc: RelatedDoc): string {
  return `#${doc.key} ${doc.title} (${doc.bucket})`;
}

/** Unresolved-link groups (formerly `kura link broken`), optionally bucket-scoped */
function auditLinks(db: Database, bucketName?: string): BrokenLink[] {
  const bucketId = bucketName ? requireBucket(db, bucketName).id : undefined;
  return brokenLinks(db, bucketId);
}

function linksJson(groups: BrokenLink[]): unknown {
  return groups.map((g) => ({ target_title: g.targetTitle, sources: g.sources }));
}

function renderLinks(groups: BrokenLink[]): void {
  if (groups.length === 0) {
    console.log("no broken links");
    return;
  }
  for (const group of groups) {
    for (const source of group.sources) {
      console.log(`[[${group.targetTitle}]] <- ${linkDocLine(source)}`);
    }
  }
}

function runLinks(parsed: Parsed): number {
  const { db } = getDb();
  const groups = auditLinks(db, strOpt(parsed, "bucket"));
  if (boolOpt(parsed, "json")) {
    console.log(JSON.stringify(linksJson(groups)));
    return EXIT.OK;
  }
  renderLinks(groups);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// tags (formerly `kura tag audit`)
// ---------------------------------------------------------------------------

function tagsJson(result: TagAuditResult): unknown {
  return {
    merges: result.merges.map((m) => ({
      from: m.from,
      to: m.to,
      reason: m.reason,
      similarity: Number(m.similarity.toFixed(4)),
    })),
    oversized: result.oversized.map((o) => ({
      path: o.path,
      count: o.count,
      share: Number(o.share.toFixed(4)),
    })),
  };
}

/** Text output + optional interactive merges for the tag-gardening audit */
async function renderTags(db: Database, result: TagAuditResult, apply: boolean): Promise<void> {
  if (result.merges.length === 0 && result.oversized.length === 0) {
    console.log("no issues found");
    return;
  }
  let merged = 0;
  for (const m of result.merges) {
    console.log(`merge: ${m.from} -> ${m.to}  (${m.reason})`);
    if (apply && (await confirm("  merge?", true))) {
      renameTag(db, m.from, m.to);
      merged++;
      console.log("  merged");
    }
  }
  for (const o of result.oversized) {
    console.log(
      `oversized: ${o.path} is attached to ${(o.share * 100).toFixed(0)}% of documents (${o.count}); consider splitting it`,
    );
  }
  if (apply) console.log(`${merged} merges applied`);
  else if (result.merges.length > 0) console.log("(use --apply to merge interactively)");
}

async function runTags(parsed: Parsed): Promise<number> {
  const config = loadConfig();
  const { db } = getDb();
  const provider = await resolveProvider(config);
  if (!provider) {
    console.error("warning: no LLM provider available; auditing with edit distance only");
  }
  const result = await auditTags(db, provider, config);
  if (boolOpt(parsed, "json")) {
    console.log(JSON.stringify(tagsJson(result), null, 2));
    return EXIT.OK;
  }
  await renderTags(db, result, boolOpt(parsed, "apply"));
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// dupes (store-wide duplicate detection)
// ---------------------------------------------------------------------------

function docRefLine(d: DupeDocRef): string {
  return `#${d.key} ${d.title}${d.path ? ` [${d.path}]` : ""}`;
}

function dupesJson(result: DupesResult): unknown {
  return {
    exact: result.exact.map((group) => group.map((d) => ({ key: d.key, title: d.title }))),
    near: result.near.map((f) => ({
      a: { key: f.a.key, title: f.a.title },
      b: { key: f.b.key, title: f.b.title },
      similarity: Number(f.similarity.toFixed(4)),
      ...(f.verdict ? { verdict: f.verdict } : {}),
    })),
  };
}

/** Text output + optional interactive merges for the duplicate audit */
async function renderDupes(db: Database, result: DupesResult, apply: boolean): Promise<void> {
  if (result.exact.length === 0 && result.near.length === 0) {
    console.log("no duplicates found");
    return;
  }
  let merged = 0;
  for (const group of result.exact) {
    console.log("exact duplicate — identical content:");
    for (const d of group) console.log(`  ${docRefLine(d)}`);
    const [survivor, ...dups] = group;
    if (!apply || !survivor) continue;
    for (const dup of dups) {
      if (await confirm(`  merge '#${dup.key}' into '#${survivor.key}'?`, false)) {
        mergeDuplicate(db, survivor.id, dup.id);
        merged++;
        console.log(`  merged #${dup.key} into #${survivor.key}`);
      }
    }
  }
  for (const f of result.near) {
    console.log(
      `${f.verdict ? "duplicate" : "possible duplicate (unjudged)"}  (similarity ${f.similarity.toFixed(3)})`,
    );
    console.log(`  A: ${docRefLine(f.a)}`);
    console.log(`  B: ${docRefLine(f.b)}`);
    if (f.verdict?.reason) console.log(`  reason: ${f.verdict.reason}`);
    if (apply && f.verdict) {
      const keepCurrent = f.verdict.keep === "current";
      const survivor = keepCurrent ? f.a : f.b;
      const dup = keepCurrent ? f.b : f.a;
      if (await confirm(`  merge '#${dup.key}' into '#${survivor.key}'?`, false)) {
        mergeDuplicate(db, survivor.id, dup.id);
        merged++;
        console.log(`  merged #${dup.key} into #${survivor.key}`);
      }
    }
  }
  if (apply) console.log(`${merged} merge(s) applied`);
  else console.log("(use --apply to merge interactively)");
}

async function runDupes(parsed: Parsed): Promise<number> {
  const config = loadConfig();
  const { db } = getDb();
  const provider = await resolveProvider(config);
  const result = await auditDupes(db, provider, config, {
    bucket: strOpt(parsed, "bucket"),
    limit: intOpt(parsed, "limit"),
  });
  for (const w of result.warnings) console.error(`warning: ${w}`);
  if (boolOpt(parsed, "json")) {
    console.log(JSON.stringify(dupesJson(result), null, 2));
    return EXIT.OK;
  }
  await renderDupes(db, result, boolOpt(parsed, "apply"));
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// contradictions (semantically close passages that conflict; LLM-required)
// ---------------------------------------------------------------------------

function contradictionsJson(outcome: AuditOutcome, contradictions: ContradictionPair[]): unknown {
  return {
    examined_pairs: outcome.examinedPairs,
    contradictions: contradictions.map((p) => ({
      a: {
        key: p.a.key,
        title: p.a.title,
        path: p.a.path,
        bucket: p.a.bucket,
        excerpt: p.a.excerpt,
      },
      b: {
        key: p.b.key,
        title: p.b.title,
        path: p.b.path,
        bucket: p.b.bucket,
        excerpt: p.b.excerpt,
      },
      similarity: Number(p.similarity.toFixed(4)),
    })),
  };
}

function renderContradictions(outcome: AuditOutcome, contradictions: ContradictionPair[]): void {
  if (contradictions.length === 0) {
    console.log(`no contradictions found (${outcome.examinedPairs} pair(s) examined)`);
    return;
  }
  for (const p of contradictions) {
    console.log(`⚠ ${pairLabel(p)}  (similarity ${p.similarity.toFixed(3)})`);
    console.log(`    A: ${p.a.excerpt}`);
    console.log(`    B: ${p.b.excerpt}`);
  }
  console.log(`${contradictions.length} contradiction(s) among ${outcome.examinedPairs} pair(s)`);
}

async function runContradictions(parsed: Parsed): Promise<number> {
  const config = loadConfig();
  const { db } = getDb();
  const provider = await requireProvider(config);
  const outcome = await findContradictions(db, provider, config, {
    bucket: strOpt(parsed, "bucket"),
    limit: intOpt(parsed, "limit"),
  });
  for (const w of outcome.warnings) console.error(`warning: ${w}`);
  const contradictions = outcome.pairs.filter((p) => p.contradictory);
  if (boolOpt(parsed, "json")) {
    console.log(JSON.stringify(contradictionsJson(outcome, contradictions), null, 2));
    return EXIT.OK;
  }
  renderContradictions(outcome, contradictions);
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// bare `kura audit` — combined, report-only
// ---------------------------------------------------------------------------

async function runAll(parsed: Parsed): Promise<number> {
  const config = loadConfig();
  const { db } = getDb();
  const bucket = strOpt(parsed, "bucket");
  const limit = intOpt(parsed, "limit");
  const provider = await resolveProvider(config);

  const links = auditLinks(db, bucket);
  const tags = await auditTags(db, provider, config);
  const dupes = await auditDupes(db, provider, config, { bucket, limit });
  let contradictions: AuditOutcome | undefined;
  let contradictionList: ContradictionPair[] = [];
  if (provider) {
    contradictions = await findContradictions(db, provider, config, { bucket, limit });
    contradictionList = contradictions.pairs.filter((p) => p.contradictory);
  }

  if (boolOpt(parsed, "json")) {
    const payload: Record<string, unknown> = {
      links: linksJson(links),
      tags: tagsJson(tags),
      dupes: dupesJson(dupes),
    };
    if (contradictions) {
      payload.contradictions = contradictionsJson(contradictions, contradictionList);
    }
    console.log(JSON.stringify(payload, null, 2));
    return EXIT.OK;
  }

  console.log("== links ==");
  renderLinks(links);

  console.log("\n== tags ==");
  if (!provider) {
    console.error("warning: no LLM provider available; auditing tags with edit distance only");
  }
  await renderTags(db, tags, false);

  console.log("\n== dupes ==");
  for (const w of dupes.warnings) console.error(`warning: ${w}`);
  await renderDupes(db, dupes, false);

  if (provider && contradictions) {
    console.log("\n== contradictions ==");
    for (const w of contradictions.warnings) console.error(`warning: ${w}`);
    renderContradictions(contradictions, contradictionList);
  } else {
    console.error("skipping contradictions (no LLM provider)");
  }
  return EXIT.OK;
}
