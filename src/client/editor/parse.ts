import type Token from "markdown-it/lib/token.mjs";
import { parseMarkdownTokens } from "../markdown";
import {
  type Block,
  blockId,
  type HeadingLevel,
  type InlineMark,
  type InlineNode,
  type ListItem,
  normalizeInline,
  paragraph,
} from "./model";

/** Markdown → block model, over the same markdown-it token stream the renderer uses */

function inlineFrom(children: Token[]): InlineNode[] {
  const out: InlineNode[] = [];
  const marks: InlineMark[] = [];
  const links: Array<{ href: string; children: InlineNode[] }> = [];

  const push = (node: InlineNode) => {
    const link = links[links.length - 1];
    (link ? link.children : out).push(node);
  };
  const drop = (mark: InlineMark) => {
    const at = marks.lastIndexOf(mark);
    if (at >= 0) marks.splice(at, 1);
  };

  for (const t of children) {
    switch (t.type) {
      case "text":
        push({ kind: "text", text: t.content, marks: [...marks] });
        break;
      case "code_inline":
        push({ kind: "text", text: t.content, marks: [...marks, "code"] });
        break;
      case "strong_open":
        marks.push("strong");
        break;
      case "strong_close":
        drop("strong");
        break;
      case "em_open":
        marks.push("em");
        break;
      case "em_close":
        drop("em");
        break;
      case "s_open":
        marks.push("strike");
        break;
      case "s_close":
        drop("strike");
        break;
      case "link_open":
        links.push({ href: t.attrGet("href") ?? "", children: [] });
        break;
      case "link_close": {
        const link = links.pop();
        if (link) push({ kind: "link", href: link.href, children: link.children });
        break;
      }
      case "wikilink":
        push({ kind: "wikilink", target: t.content });
        break;
      case "image":
        push({ kind: "image", src: t.attrGet("src") ?? "", alt: t.content });
        break;
      case "hardbreak":
        push({ kind: "br" });
        break;
      case "softbreak":
        // A newline inside a paragraph: kept literal, so CJK text does not gain a space
        push({ kind: "text", text: "\n", marks: [] });
        break;
      case "html_inline":
        push({ kind: "text", text: t.content, marks: [...marks] });
        break;
    }
  }
  return normalizeInline(out);
}

function sliceLines(lines: string[], map: [number, number] | null): string {
  if (map === null) return "";
  return lines.slice(map[0], map[1]).join("\n");
}

interface Walk {
  tokens: Token[];
  lines: string[];
}

/** Flattens nested lists into depth-tagged items (see ListItem in model.ts) */
function listAt(w: Walk, start: number, ordered: boolean, depth: number, out: ListItem[]): number {
  const close = ordered ? "ordered_list_close" : "bullet_list_close";
  let i = start;
  while (i < w.tokens.length) {
    const t = w.tokens[i];
    if (t === undefined || t.type === close) return i + 1;
    if (t.type === "list_item_open") {
      i = itemAt(w, i + 1, ordered, depth, out);
    } else {
      i += 1;
    }
  }
  return i;
}

function itemAt(w: Walk, start: number, ordered: boolean, depth: number, out: ListItem[]): number {
  const item: ListItem = { inline: [], depth, ordered };
  out.push(item);
  let i = start;
  while (i < w.tokens.length) {
    const t = w.tokens[i];
    if (t === undefined || t.type === "list_item_close") return i + 1;
    if (t.type === "paragraph_open" || t.type === "heading_open") {
      const content = w.tokens[i + 1];
      if (item.inline.length === 0 && content) item.inline = inlineFrom(content.children ?? []);
      i += 3;
    } else if (t.type === "bullet_list_open" || t.type === "ordered_list_open") {
      i = listAt(w, i + 1, t.type === "ordered_list_open", depth + 1, out);
    } else {
      i += 1;
    }
  }
  return i;
}

function blocksAt(w: Walk, start: number, stop: string | null): { blocks: Block[]; next: number } {
  const blocks: Block[] = [];
  let i = start;

  while (i < w.tokens.length) {
    const t = w.tokens[i];
    if (t === undefined) break;
    if (stop !== null && t.type === stop) return { blocks, next: i + 1 };

    switch (t.type) {
      case "heading_open": {
        const level = Math.min(Math.max(Number(t.tag.slice(1)) || 1, 1), 6) as HeadingLevel;
        const content = w.tokens[i + 1];
        blocks.push({
          id: blockId(),
          type: "heading",
          level,
          inline: inlineFrom(content?.children ?? []),
        });
        i += 3;
        break;
      }
      case "paragraph_open": {
        const content = w.tokens[i + 1];
        blocks.push({
          id: blockId(),
          type: "paragraph",
          inline: inlineFrom(content?.children ?? []),
        });
        i += 3;
        break;
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        const items: ListItem[] = [];
        i = listAt(w, i + 1, t.type === "ordered_list_open", 0, items);
        blocks.push({ id: blockId(), type: "list", items });
        break;
      }
      case "blockquote_open": {
        // Blockquotes are edited as one inline run; nested block structure inside them is rare
        const res = blocksAt(w, i + 1, "blockquote_close");
        const inline: InlineNode[] = [];
        for (const b of res.blocks) {
          if (b.type === "paragraph" || b.type === "heading") {
            if (inline.length > 0) inline.push({ kind: "text", text: "\n", marks: [] });
            inline.push(...b.inline);
          }
        }
        blocks.push({ id: blockId(), type: "blockquote", inline: normalizeInline(inline) });
        i = res.next;
        break;
      }
      case "fence":
      case "code_block":
        blocks.push({
          id: blockId(),
          type: "code",
          lang: (t.info ?? "").trim(),
          text: t.content.replace(/\n$/, ""),
        });
        i += 1;
        break;
      case "table_open": {
        blocks.push({
          id: blockId(),
          type: "table",
          markdown: sliceLines(w.lines, t.map as [number, number] | null),
        });
        // Skip to the matching close
        while (i < w.tokens.length && w.tokens[i]?.type !== "table_close") i += 1;
        i += 1;
        break;
      }
      case "html_block":
        blocks.push({ id: blockId(), type: "html", html: t.content.replace(/\n$/, "") });
        i += 1;
        break;
      case "hr":
        blocks.push({ id: blockId(), type: "hr" });
        i += 1;
        break;
      default:
        i += 1;
    }
  }
  return { blocks, next: i };
}

export function parseMarkdown(content: string): Block[] {
  const w: Walk = { tokens: parseMarkdownTokens(content), lines: content.split("\n") };
  const { blocks } = blocksAt(w, 0, null);
  return blocks.length === 0 ? [paragraph()] : blocks;
}
