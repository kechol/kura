/** Plain-text card excerpt for list surfaces (docs: http-api.md). */

import type { ContentType } from "./documents";
import { FENCE_CLOSE_RE, FENCE_OPEN_RE, LINK_RE, TAG_RE } from "./wiki";

/** Cap regex cost: never scan more than this many characters of the body */
const MAX_SCAN = 2000;

/** Front matter block at the very start (defensive): --- ... --- */
const FRONT_MATTER_RE = /^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/;

/** Markdown image: removed entirely */
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;

/** Markdown link [text](url) -> text */
const MD_LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;

/**
 * Line-start markers (ATX heading, blockquote, unordered / ordered list item)
 * at every line start. Whitespace is narrowed to [ \t] so the multiline (gm)
 * form matches within a single line and never spans a newline or blank line.
 */
const LINE_MARKER_RE = /^[ \t]{0,3}(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d+[.)][ \t]+)/gm;

export function docExcerpt(content: string, contentType: ContentType, max = 200): string {
  const scan = content.slice(0, MAX_SCAN);
  const text = contentType === "html" ? stripHtml(scan) : stripMarkdown(scan);
  return truncate(text, max);
}

function stripMarkdown(input: string): string {
  let s = input.replace(FRONT_MATTER_RE, "");
  s = stripFences(s);
  s = s.replace(LINK_RE, (_m, target: string, display?: string) => {
    const d = display?.trim();
    if (d) return d;
    const t = (target ?? "").trim();
    if (t === "") return "";
    const segments = t.split("/");
    return segments[segments.length - 1] ?? t;
  });
  s = s.replace(IMAGE_RE, "");
  s = s.replace(MD_LINK_RE, (_m, text: string) => text);
  s = s.replace(TAG_RE, "");
  // Strip line-start markers in one multiline pass, then inline emphasis / code
  // markers (keep the text)
  s = s
    .replace(LINE_MARKER_RE, "")
    .replaceAll("~~", "")
    .replaceAll("**", "")
    .replaceAll("*", "")
    .replaceAll("`", "");
  return s;
}

/** Drop fenced code blocks; an unclosed trailing fence drops to end of input */
function stripFences(input: string): string {
  const out: string[] = [];
  let fenceChar = "";
  let fenceLen = 0;
  for (const line of input.split(/\r?\n/)) {
    if (fenceLen > 0) {
      const close = FENCE_CLOSE_RE.exec(line)?.[1];
      if (close?.startsWith(fenceChar) && close.length >= fenceLen) fenceLen = 0;
      continue; // drop fence body and the closing fence line
    }
    const open = FENCE_OPEN_RE.exec(line);
    if (open) {
      const marker = open[1] ?? "";
      const info = open[2] ?? "";
      if (marker.startsWith("~") || !info.includes("`")) {
        fenceChar = marker.charAt(0);
        fenceLen = marker.length;
        continue; // drop the opening fence line
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function stripHtml(input: string): string {
  // Remove script / style with their contents, then all remaining tags -> space
  let s = input.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  // Decode the common named / numeric entities. &amp; is decoded last so an
  // encoded entity like &amp;lt; is not double-decoded into <.
  s = s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&");
  return s;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replaceAll(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
