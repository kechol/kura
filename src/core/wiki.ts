/** Parser for wiki links and hashtags (docs: document-notation.md) */

export interface WikiLink {
  /** Title part inside [[...]] (trimmed, original case preserved) */
  target: string;
  /** Display part of [[title|display]]; null when absent */
  display: string | null;
}

export interface WikiExtraction {
  /** In order of appearance. Deduplicated by lowercase target (first occurrence kept) */
  links: WikiLink[];
  /** normalizeTagPath applied, deduplicated, in order of appearance */
  tags: string[];
}

/** Normalize a tag path: lowercase, strip leading/trailing slashes, collapse repeated slashes, trim each segment. null when empty */
export function normalizeTagPath(raw: string): string | null {
  const segments = raw
    .toLowerCase()
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments.join("/") : null;
}

/**
 * Normalize a document path: strip leading/trailing slashes, collapse repeated
 * slashes, trim each segment. Unlike tag paths, case is preserved.
 * '' means the bucket root (docs: document-notation.md).
 */
export function normalizeDocPath(raw: string): string {
  return raw
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join("/");
}

/** Computed full path of a document; a root path ('') yields the title alone */
export function joinDocPath(path: string, title: string): string {
  return path === "" ? title : `${path}/${title}`;
}

/**
 * Normalize a document alias: trim, reject characters that would break the
 * [[...]] notation ([ ] | and newlines) or collide with full-path resolution
 * (/). Case is preserved; matching is case-insensitive. null when invalid.
 */
export function normalizeAlias(raw: string): string | null {
  const alias = raw.trim();
  if (alias === "" || /[[\]|/\n\r]/.test(alias)) return null;
  return alias;
}

// The four notation regexes below are the single source of truth: excerpt.ts
// imports them to strip the same wiki links, tags, and code fences.

/** [[title]] / [[title|display]]. The title part cannot contain [ ] | */
export const LINK_RE = /\[\[([^[\]|\n]*)(?:\|([^[\]\n]*))?\]\]/g;

/** A tag only when # is preceded by line start, whitespace, or an opening bracket. Tag characters are Unicode letters/digits/-/_, hierarchy separator is /. Group 1 is the tag body (unused by excerpt.ts's whole-match strip) */
export const TAG_RE = /(?<=^|[\s([{（「『【〔〈《])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;

/** Fence opening line: up to 3 spaces of indent + 3+ backticks or tildes + info string */
export const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Fence closing line: only a run of fence characters (trailing whitespace allowed) */
export const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

const LINE_SPLIT_RE = /\r?\n/;

/** Enumerate lines outside fenced code blocks, with inline code masked */
function* visibleLines(content: string): Generator<string> {
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of content.split(LINE_SPLIT_RE)) {
    if (fenceLen > 0) {
      const close = FENCE_CLOSE_RE.exec(line)?.[1];
      if (close?.startsWith(fenceChar) && close.length >= fenceLen) fenceLen = 0;
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      const marker = open[1] ?? "";
      const info = open[2] ?? "";
      // A backtick fence's info string cannot contain ` (CommonMark)
      if (marker.startsWith("~") || !info.includes("`")) {
        fenceChar = marker.charAt(0);
        fenceLen = marker.length;
        continue;
      }
    }
    yield maskInlineCode(line);
  }
}

/** Mask inline code spans (pairs of equal-length backtick runs) with `. Unpaired backticks stay as-is */
function maskInlineCode(line: string): string {
  let out = "";
  let i = 0;
  while (i < line.length) {
    const ch = line.charAt(i);
    if (ch !== "`") {
      out += ch;
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && line.charAt(j) === "`") j++;
    const runLen = j - i;
    const close = findClosingRun(line, j, runLen);
    if (close === -1) {
      out += line.slice(i, j);
      i = j;
    } else {
      out += "`".repeat(close + runLen - i);
      i = close + runLen;
    }
  }
  return out;
}

/** Find the start of a backtick run of exactly length n at or after from (CommonMark closing rule) */
function findClosingRun(line: string, from: number, n: number): number {
  let k = from;
  while (k < line.length) {
    if (line.charAt(k) !== "`") {
      k++;
      continue;
    }
    let m = k;
    while (m < line.length && line.charAt(m) === "`") m++;
    if (m - k === n) return k;
    k = m;
  }
  return -1;
}

export interface WikiLinkReplacement {
  from: string;
  to: string;
}

/**
 * Replace the title part of [[target]] / [[target|display]] for every entry in
 * replacements (link rewriting for kura mv — a rename may need both the title
 * and the full-path spelling swapped in one pass). Matches case-insensitively;
 * code blocks and inline code are left untouched.
 */
export function replaceWikiLinkTargets(
  content: string,
  replacements: WikiLinkReplacement[],
): string {
  const map = new Map<string, string>();
  for (const r of replacements) {
    const key = r.from.trim().toLowerCase();
    if (!map.has(key)) map.set(key, r.to);
  }
  let fenceChar = "";
  let fenceLen = 0;
  const out: string[] = [];
  const parts = content.split(/(\r?\n)/);
  for (let idx = 0; idx < parts.length; idx += 2) {
    const line = parts[idx] ?? "";
    const sep = parts[idx + 1] ?? "";
    if (fenceLen > 0) {
      const close = FENCE_CLOSE_RE.exec(line)?.[1];
      if (close?.startsWith(fenceChar) && close.length >= fenceLen) fenceLen = 0;
      out.push(line, sep);
      continue;
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      const marker = open[1] ?? "";
      const info = open[2] ?? "";
      if (marker.startsWith("~") || !info.includes("`")) {
        fenceChar = marker.charAt(0);
        fenceLen = marker.length;
        out.push(line, sep);
        continue;
      }
    }
    // Masking preserves length, so match positions on the masked line apply directly to the original
    const masked = maskInlineCode(line);
    let rewritten = "";
    let last = 0;
    for (const m of masked.matchAll(LINK_RE)) {
      const target = (m[1] ?? "").trim();
      const to = map.get(target.toLowerCase());
      if (to === undefined) continue;
      const titleStart = m.index + 2;
      const titleEnd = titleStart + (m[1] ?? "").length;
      rewritten += line.slice(last, titleStart) + to;
      last = titleEnd;
    }
    out.push(rewritten + line.slice(last), sep);
  }
  return out.join("");
}

/** Extract [[links]] and #tags from the body (expects Markdown with frontmatter already removed) */
export function extractWiki(content: string): WikiExtraction {
  const links: WikiLink[] = [];
  const seenTargets = new Set<string>();
  const tags: string[] = [];
  const seenTags = new Set<string>();
  for (const line of visibleLines(content)) {
    for (const m of line.matchAll(LINK_RE)) {
      const target = (m[1] ?? "").trim();
      if (target === "") continue;
      const key = target.toLowerCase();
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      const display = m[2]?.trim() ?? "";
      links.push({ target, display: display === "" ? null : display });
    }
    for (const m of line.matchAll(TAG_RE)) {
      const tag = normalizeTagPath(m[1] ?? "");
      if (tag === null || seenTags.has(tag)) continue;
      seenTags.add(tag);
      tags.push(tag);
    }
  }
  return { links, tags };
}
