import type { Database } from "bun:sqlite";
import { requireBucket } from "../../core/buckets";
import { loadConfig } from "../../core/config";
import { getDb } from "../../core/db";
import { type DupeCandidate, mergeDuplicate } from "../../core/dedupe";
import {
  type DocumentRecord,
  getDocumentById,
  markTriaged,
  resolveDoc,
  updateDocument,
} from "../../core/documents";
import { appendRelatedLinks } from "../../core/linking";
import { resolveProvider } from "../../core/llm/provider";
import { ensureEmbeddings } from "../../core/search/vector";
import { addTagsToDoc } from "../../core/tags";
import {
  listTriageBacklog,
  TRIAGE_STEPS,
  type TriageReport,
  type TriageStep,
  triageDocument,
} from "../../core/triage";
import { joinDocPath, normalizeDocPath } from "../../core/wiki";
import {
  boolOpt,
  ConflictError,
  EXIT,
  intOpt,
  listOpt,
  parseCommandArgs,
  strOpt,
  UsageError,
} from "../args";
import { ask, isInteractive } from "../prompt";

export const summary = "Organize backlog documents (dedupe, title, tags, path, links)";

export const usage = `Usage: kura triage [<doc>...] [options]

Walks the triage backlog — documents at the bucket root or without tags,
excluding ones already triaged and unchanged since — and pipes each through
the organizing steps: dedupe, title, tags, path, links. With <doc>
arguments it triages exactly those documents instead.

Options:
  --bucket <name>   Scope to this bucket (default: general.default_bucket)
  --limit <n>       Only consider the first n backlog documents
  --steps <list>    Comma-separated subset of: dedupe,title,tags,path,links
  --apply           Apply every suggestion without confirmation (except merges)
  --json            Print suggestions as JSON (never applies)
  --redo            Include documents already marked triaged`;

function pathLabel(p: string): string {
  return p === "" ? "(root)" : p;
}

function tagsLabel(tags: string[]): string {
  return tags.length > 0 ? tags.join(", ") : "(none)";
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function printHeader(doc: DocumentRecord, i: number, n: number): void {
  console.log(`#${doc.key}  ${doc.title}  [${i}/${n}]`);
  console.log(`  path: ${pathLabel(doc.path)}  tags: ${tagsLabel(doc.tags)}`);
}

/** One-line annotation for a duplicate candidate (similarity plus exact / LLM verdict) */
function dupeAnnotation(c: DupeCandidate): string {
  const sim = `similarity ${round2(c.similarity).toFixed(2)}`;
  if (c.exact) return `${sim}, exact duplicate`;
  if (!c.verdict) return sim;
  if (!c.verdict.duplicate) return `${sim}, LLM: likely not a duplicate`;
  const keep = c.verdict.keep === "current" ? "keep current" : "keep other";
  return `${sim}, LLM: ${keep}${c.verdict.reason ? ` — ${c.verdict.reason}` : ""}`;
}

/** JSON payload for one document's triage report (stable contract, invariants R7) */
function reportToJson(report: TriageReport): unknown {
  const steps: Record<string, unknown> = {};
  if (report.dedupe) {
    steps.dedupe = {
      candidates: report.dedupe.candidates.map((c) => ({
        key: c.doc.key,
        title: c.doc.title,
        similarity: round2(c.similarity),
        exact: c.exact,
        ...(c.verdict ? { verdict: c.verdict } : {}),
      })),
    };
  }
  if (report.title !== undefined) {
    steps.title = report.title
      ? {
          proposed: report.title.title,
          ...(report.title.reason ? { reason: report.title.reason } : {}),
        }
      : null;
  }
  if (report.tags !== undefined) steps.tags = report.tags;
  if (report.path !== undefined) steps.path = report.path;
  if (report.links !== undefined) {
    steps.links = report.links.map((l) => ({
      title: l.doc.title,
      similarity: round2(l.similarity),
      judged: l.source === "vector",
    }));
  }
  return { key: report.doc.key, title: report.doc.title, steps, warnings: report.warnings };
}

interface DocOutcome {
  applied: number;
  merged: number;
  /** Whether the document should be stamped triaged after this pass */
  triaged: boolean;
  /** Stop the whole run after this document (the interactive 'q' answer) */
  quit: boolean;
}

// Per-field apply helpers shared by the interactive and --apply paths. Each owns
// the write plus its log line and returns the fresh record, or null when nothing
// was applied (conflict, no-op).

function applyTitle(db: Database, doc: DocumentRecord, title: string): DocumentRecord | null {
  try {
    const record = updateDocument(db, doc.id, { title }).record;
    console.log(`  renamed -> ${record.title}`);
    return record;
  } catch (e) {
    if (e instanceof ConflictError) {
      console.error("warning: title conflicts with an existing document; skipped");
      return null;
    }
    throw e;
  }
}

function applyPath(db: Database, doc: DocumentRecord, path: string): DocumentRecord | null {
  try {
    const record = updateDocument(db, doc.id, { path }).record;
    console.log(`  moved -> ${joinDocPath(record.path, record.title)}`);
    return record;
  } catch (e) {
    if (e instanceof ConflictError) {
      console.error("warning: path conflicts with an existing document; skipped");
      return null;
    }
    throw e;
  }
}

function applyTags(db: Database, doc: DocumentRecord, tags: string[]): DocumentRecord | null {
  const added = addTagsToDoc(db, doc.id, tags, "auto");
  if (added.length === 0) return null;
  console.log(`  tagged: ${added.join(", ")}`);
  return getDocumentById(db, doc.id);
}

function applyLinks(db: Database, doc: DocumentRecord, titles: string[]): DocumentRecord | null {
  // Refetch: earlier applications in this document's flow may have changed the body.
  const fresh = getDocumentById(db, doc.id);
  const content = appendRelatedLinks(fresh.content, titles);
  if (content === fresh.content) return null;
  const record = updateDocument(db, doc.id, { content }).record;
  console.log(`  linked: ${titles.join(", ")}`);
  return record;
}

/** Interactive per-document walk. Threads the freshest record through the steps. */
async function processInteractive(
  db: Database,
  report: TriageReport,
  i: number,
  n: number,
): Promise<DocOutcome> {
  let current = report.doc;
  let applied = 0;
  let merged = 0;
  printHeader(current, i, n);

  for (const step of TRIAGE_STEPS) {
    if (step === "dedupe" && report.dedupe) {
      const cand = report.dedupe.candidates[0];
      if (!cand) continue;
      console.log(`  duplicate: #${cand.doc.key} ${cand.doc.title} (${dupeAnnotation(cand)})`);
      const ans = (await ask("  merge? [y/n/s/q] ")).toLowerCase();
      if (ans === "q") return { applied, merged, triaged: false, quit: true };
      if (ans === "s") return { applied, merged, triaged: true, quit: false };
      if (ans === "y") {
        // Exact / unjudged candidates default to keeping the current document.
        const keepCurrent = cand.verdict?.keep !== "other";
        if (keepCurrent) {
          mergeDuplicate(db, current.id, cand.doc.id);
          merged++;
          console.log(`  merged #${cand.doc.key} into this document`);
          current = getDocumentById(db, current.id);
        } else {
          mergeDuplicate(db, cand.doc.id, current.id);
          merged++;
          console.log(`  merged into #${cand.doc.key}`);
          // This document no longer exists: skip its remaining steps, don't mark.
          return { applied, merged, triaged: false, quit: false };
        }
      }
    } else if (step === "title" && report.title) {
      console.log(
        `  title: '${report.title.title}'${report.title.reason ? ` — ${report.title.reason}` : ""}`,
      );
      const ans = (await ask("  rename? [y/e/n/s/q] ")).toLowerCase();
      if (ans === "q") return { applied, merged, triaged: false, quit: true };
      if (ans === "s") return { applied, merged, triaged: true, quit: false };
      let newTitle: string | null = null;
      if (ans === "y") newTitle = report.title.title;
      else if (ans === "e") {
        const edited = (await ask("  title: ")).trim();
        newTitle = edited === "" ? null : edited;
      }
      if (newTitle !== null) {
        const record = applyTitle(db, current, newTitle);
        if (record) {
          current = record;
          applied++;
        }
      }
    } else if (step === "tags" && report.tags && report.tags.length > 0) {
      console.log(`  tags: ${report.tags.join(", ")}`);
      const ans = (await ask("  add? [y/e/n/s/q] ")).toLowerCase();
      if (ans === "q") return { applied, merged, triaged: false, quit: true };
      if (ans === "s") return { applied, merged, triaged: true, quit: false };
      let toAdd: string[] | null = null;
      if (ans === "y") toAdd = report.tags;
      else if (ans === "e") {
        const parsed = (await ask("  tags: "))
          .split(",")
          .map((t) => t.trim())
          .filter((t) => t !== "");
        toAdd = parsed.length > 0 ? parsed : null;
      }
      if (toAdd !== null) {
        const record = applyTags(db, current, toAdd);
        if (record) {
          current = record;
          applied++;
        }
      }
    } else if (step === "path" && report.path) {
      console.log(
        `  path: ${report.path.path}${report.path.reason ? ` — ${report.path.reason}` : ""}`,
      );
      const ans = (await ask("  move? [y/e/n/s/q] ")).toLowerCase();
      if (ans === "q") return { applied, merged, triaged: false, quit: true };
      if (ans === "s") return { applied, merged, triaged: true, quit: false };
      let newPath: string | null = null;
      if (ans === "y") newPath = report.path.path;
      else if (ans === "e") {
        const edited = normalizeDocPath(await ask("  path: "));
        newPath = edited === "" ? null : edited;
      }
      if (newPath !== null) {
        const record = applyPath(db, current, newPath);
        if (record) {
          current = record;
          applied++;
        }
      }
    } else if (step === "links" && report.links && report.links.length > 0) {
      const titles = report.links.map((l) => l.doc.title);
      console.log(`  links: ${titles.map((t) => `[[${t}]]`).join(", ")}`);
      const ans = (await ask("  add under '## 関連'? [y/n/s/q] ")).toLowerCase();
      if (ans === "q") return { applied, merged, triaged: false, quit: true };
      if (ans === "s") return { applied, merged, triaged: true, quit: false };
      if (ans === "y") {
        const record = applyLinks(db, current, titles);
        if (record) {
          current = record;
          applied++;
        }
      }
    }
  }
  return { applied, merged, triaged: true, quit: false };
}

/** Non-interactive --apply: apply every suggestion, never merge duplicates. */
function processApply(db: Database, report: TriageReport, i: number, n: number): number {
  let current = report.doc;
  let applied = 0;
  printHeader(current, i, n);

  for (const step of TRIAGE_STEPS) {
    if (step === "dedupe" && report.dedupe) {
      const cand = report.dedupe.candidates[0];
      if (cand) {
        console.log(
          `  possible duplicate of #${cand.doc.key} — run 'kura triage' interactively or 'kura audit dupes' to merge`,
        );
      }
    } else if (step === "title" && report.title) {
      const record = applyTitle(db, current, report.title.title);
      if (record) {
        current = record;
        applied++;
      }
    } else if (step === "tags" && report.tags && report.tags.length > 0) {
      const record = applyTags(db, current, report.tags);
      if (record) {
        current = record;
        applied++;
      }
    } else if (step === "path" && report.path) {
      const record = applyPath(db, current, report.path.path);
      if (record) {
        current = record;
        applied++;
      }
    } else if (step === "links" && report.links && report.links.length > 0) {
      const record = applyLinks(
        db,
        current,
        report.links.map((l) => l.doc.title),
      );
      if (record) {
        current = record;
        applied++;
      }
    }
  }
  return applied;
}

/** Dry run (non-TTY, no --apply): print proposals, apply nothing, mark nothing. */
function printDryRun(report: TriageReport, i: number, n: number): void {
  printHeader(report.doc, i, n);
  if (report.dedupe) {
    const c = report.dedupe.candidates[0];
    if (c) console.log(`  duplicate: #${c.doc.key} ${c.doc.title} (${dupeAnnotation(c)})`);
  }
  if (report.title) {
    console.log(
      `  title: '${report.title.title}'${report.title.reason ? ` — ${report.title.reason}` : ""}`,
    );
  }
  if (report.tags && report.tags.length > 0) console.log(`  tags: ${report.tags.join(", ")}`);
  if (report.path) {
    console.log(
      `  path: ${report.path.path}${report.path.reason ? ` — ${report.path.reason}` : ""}`,
    );
  }
  if (report.links && report.links.length > 0) {
    console.log(`  links: ${report.links.map((l) => `[[${l.doc.title}]]`).join(", ")}`);
  }
}

function resolveSteps(requested: string[]): readonly TriageStep[] {
  if (requested.length === 0) return TRIAGE_STEPS;
  for (const s of requested) {
    if (!(TRIAGE_STEPS as readonly string[]).includes(s)) {
      throw new UsageError(`unknown step '${s}'; valid steps are: ${TRIAGE_STEPS.join(", ")}`);
    }
  }
  return TRIAGE_STEPS.filter((s) => requested.includes(s));
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseCommandArgs(argv, {
    bucket: { type: "string" },
    limit: { type: "string" },
    steps: { type: "string" },
    apply: { type: "boolean", default: false },
    redo: { type: "boolean", default: false },
  });

  const jsonOut = boolOpt(parsed, "json");
  const apply = boolOpt(parsed, "apply");
  if (jsonOut && apply) throw new UsageError("--json and --apply are mutually exclusive");

  const steps = resolveSteps(listOpt(parsed, "steps"));

  const config = loadConfig();
  const { db, tokenizer } = getDb();
  const bucketFlag = strOpt(parsed, "bucket");
  const bucketName = bucketFlag ?? config.general.default_bucket;
  requireBucket(db, bucketName);

  // Resolve the working set as ids: explicit specs (any doc) or the triage
  // backlog. Each document is re-fetched fresh inside the loop.
  let docIds: number[];
  if (parsed.positionals.length > 0) {
    docIds = parsed.positionals.map((spec) => resolveDoc(db, spec, bucketFlag).id);
  } else {
    docIds = listTriageBacklog(db, bucketName, {
      redo: boolOpt(parsed, "redo"),
      limit: intOpt(parsed, "limit"),
    });
    if (docIds.length === 0) {
      console.log(jsonOut ? "[]" : `no documents in the triage backlog of bucket '${bucketName}'`);
      return EXIT.OK;
    }
  }

  const provider = await resolveProvider(config);
  if (!provider) {
    console.error(
      "warning: no LLM provider available; suggesting from keyword and structural signals only",
    );
  } else {
    try {
      const embedWarn = await ensureEmbeddings(db, provider, config);
      if (embedWarn) console.error(`warning: ${embedWarn}`);
    } catch (e) {
      console.error(`warning: embedding backfill failed (${e instanceof Error ? e.message : e})`);
    }
  }

  const seenWarnings = new Set<string>();
  const warnOnce = (w: string): void => {
    if (seenWarnings.has(w)) return;
    seenWarnings.add(w);
    console.error(`warning: ${w}`);
  };

  const interactive = !apply && isInteractive();
  const results: unknown[] = [];
  let triagedCount = 0;
  let applied = 0;
  let merged = 0;

  for (let i = 0; i < docIds.length; i++) {
    const id = docIds[i]!;
    // An earlier interactive merge may have deleted a document later in the list.
    if (!db.prepare("SELECT 1 FROM documents WHERE id = ?").get(id)) continue;
    const doc = getDocumentById(db, id);
    const report = await triageDocument(db, tokenizer, config, provider, doc, steps);

    if (jsonOut) {
      results.push(reportToJson(report));
      continue;
    }

    for (const w of report.warnings) warnOnce(w);

    if (apply) {
      applied += processApply(db, report, i + 1, docIds.length);
      markTriaged(db, id);
      triagedCount++;
    } else if (interactive) {
      const outcome = await processInteractive(db, report, i + 1, docIds.length);
      applied += outcome.applied;
      merged += outcome.merged;
      if (outcome.triaged) {
        markTriaged(db, id);
        triagedCount++;
      }
      if (outcome.quit) break;
    } else {
      printDryRun(report, i + 1, docIds.length);
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify(results, null, 2));
    return EXIT.OK;
  }

  const mergedPart = merged > 0 ? `, ${merged} merged` : "";
  console.log(`${triagedCount} documents triaged, ${applied} suggestions applied${mergedPart}`);
  if (!apply && !interactive) {
    console.log("dry run — pass --apply to apply, or run on a TTY to confirm per document");
  }
  return EXIT.OK;
}
