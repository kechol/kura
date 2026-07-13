/**
 * Editor document model (docs: browser-ui.md).
 *
 * The model is the source of truth while editing; Markdown is what it serializes to.
 * Every edit updates the model, and the document is saved by serializing it — the DOM
 * is only a view, re-derived on structural changes.
 */

export type InlineMark = "strong" | "em" | "code" | "strike";

export type InlineNode =
  | { kind: "text"; text: string; marks: InlineMark[] }
  | { kind: "link"; href: string; children: InlineNode[] }
  /** [[Title]] — kept atomic so serialization never has to escape its brackets */
  | { kind: "wikilink"; target: string }
  | { kind: "image"; src: string; alt: string }
  /** Hard line break (Shift+Enter) */
  | { kind: "br" };

/**
 * List items are flat, each carrying its own depth and marker. Nesting is a rendering and
 * serialization concern — keeping the model flat is what makes Enter / Backspace / Tab
 * tractable, and it still round-trips a bullet list with an ordered list nested inside.
 */
export interface ListItem {
  inline: InlineNode[];
  depth: number;
  ordered: boolean;
}

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type Block =
  | { id: string; type: "paragraph"; inline: InlineNode[] }
  | { id: string; type: "heading"; level: HeadingLevel; inline: InlineNode[] }
  | { id: string; type: "list"; items: ListItem[] }
  | { id: string; type: "blockquote"; inline: InlineNode[] }
  /** Raw-edited (code / mermaid), rendered as a preview when not focused */
  | { id: string; type: "code"; lang: string; text: string }
  /** Raw-edited: tables and inline HTML are round-tripped verbatim */
  | { id: string; type: "table"; markdown: string }
  | { id: string; type: "html"; html: string }
  | { id: string; type: "hr" };

export type BlockType = Block["type"];

let counter = 0;

export function blockId(): string {
  counter += 1;
  return `b${counter}`;
}

export function paragraph(inline: InlineNode[] = []): Block {
  return { id: blockId(), type: "paragraph", inline };
}

export function text(value: string, marks: InlineMark[] = []): InlineNode {
  return { kind: "text", text: value, marks };
}

/** Blocks whose content is edited as raw text rather than rich inline nodes */
export function isRawBlock(block: Block): boolean {
  return block.type === "code" || block.type === "table" || block.type === "html";
}

export function inlineOf(block: Block): InlineNode[] | null {
  if (block.type === "paragraph" || block.type === "heading" || block.type === "blockquote") {
    return block.inline;
  }
  return null;
}

export function withInline(block: Block, inline: InlineNode[]): Block {
  if (block.type === "paragraph" || block.type === "heading" || block.type === "blockquote") {
    return { ...block, inline };
  }
  return block;
}

function sameMarks(a: InlineMark[], b: InlineMark[]): boolean {
  return a.length === b.length && a.every((m) => b.includes(m));
}

const WIKILINK_RE = /\[\[([^[\]\n]+)\]\]/g;

function mergeRuns(nodes: InlineNode[]): InlineNode[] {
  const merged: InlineNode[] = [];
  for (const node of nodes) {
    if (node.kind === "text" && node.text === "") continue;
    const prev = merged[merged.length - 1];
    if (
      node.kind === "text" &&
      prev !== undefined &&
      prev.kind === "text" &&
      sameMarks(prev.marks, node.marks)
    ) {
      merged[merged.length - 1] = { ...prev, text: prev.text + node.text };
      continue;
    }
    merged.push(node);
  }
  return merged;
}

/**
 * Canonical form of an inline run: adjacent runs with the same marks merge, empty text
 * disappears, and `[[Title]]` written as plain text becomes a wikilink node. Both the parser
 * and the DOM reader end here, so a round trip cannot drift — and because the merge runs
 * first, a wikilink typed across several DOM text nodes is still recognised.
 */
export function normalizeInline(nodes: InlineNode[]): InlineNode[] {
  const expanded: InlineNode[] = [];
  for (const node of mergeRuns(nodes)) {
    if (node.kind === "link") {
      expanded.push({ ...node, children: normalizeInline(node.children) });
      continue;
    }
    if (node.kind !== "text") {
      expanded.push(node);
      continue;
    }
    let last = 0;
    WIKILINK_RE.lastIndex = 0;
    let match = WIKILINK_RE.exec(node.text);
    while (match !== null) {
      if (match.index > last) {
        expanded.push({
          kind: "text",
          text: node.text.slice(last, match.index),
          marks: node.marks,
        });
      }
      expanded.push({ kind: "wikilink", target: (match[1] ?? "").trim() });
      last = match.index + match[0].length;
      match = WIKILINK_RE.exec(node.text);
    }
    if (last < node.text.length) {
      expanded.push({ kind: "text", text: node.text.slice(last), marks: node.marks });
    }
  }
  return mergeRuns(expanded);
}

/** Plain text of an inline run (caret math, empty-block checks) */
export function inlineText(nodes: InlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += node.text;
        break;
      case "link":
        out += inlineText(node.children);
        break;
      case "wikilink":
        out += `[[${node.target}]]`;
        break;
      case "image":
        out += node.alt;
        break;
      case "br":
        out += "\n";
        break;
    }
  }
  return out;
}

export function isBlockEmpty(block: Block): boolean {
  const inline = inlineOf(block);
  if (inline !== null) return inlineText(inline) === "";
  if (block.type === "code") return block.text === "";
  if (block.type === "table") return block.markdown === "";
  if (block.type === "html") return block.html === "";
  if (block.type === "list") return block.items.every((i) => inlineText(i.inline) === "");
  return false;
}

export function listItem(inline: InlineNode[] = [], depth = 0, ordered = false): ListItem {
  return { inline, depth, ordered };
}
