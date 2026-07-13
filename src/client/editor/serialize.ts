import type { Block, InlineMark, InlineNode, ListItem } from "./model";

/** Block model → Markdown. The inverse of parse.ts; tests assert the round trip. */

/** Escape only what would otherwise re-parse as markup. `[` is safe: wikilinks are nodes. */
function escapeText(value: string): string {
  return value.replace(/([\\*_`~])/g, "\\$1");
}

/** A paragraph starting with a block marker would re-parse as that block */
function escapeLineStarts(value: string): string {
  return value.replace(/^(\s*)(#{1,6} |[-+*] |\d+\. |> |```)/gm, "$1\\$2");
}

function wrap(value: string, marks: InlineMark[]): string {
  let out = marks.includes("code") ? `\`${value}\`` : escapeText(value);
  if (marks.includes("strike")) out = `~~${out}~~`;
  if (marks.includes("em")) out = `*${out}*`;
  if (marks.includes("strong")) out = `**${out}**`;
  return out;
}

export function serializeInline(nodes: InlineNode[]): string {
  let out = "";
  for (const node of nodes) {
    switch (node.kind) {
      case "text":
        out += wrap(node.text, node.marks);
        break;
      case "link":
        out += `[${serializeInline(node.children)}](${node.href})`;
        break;
      case "wikilink":
        out += `[[${node.target}]]`;
        break;
      case "image":
        out += `![${node.alt}](${node.src})`;
        break;
      case "br":
        out += "  \n";
        break;
    }
  }
  return out;
}

/** Depth-tagged items back to nested markdown; ordered items are numbered per depth run */
function serializeList(items: ListItem[]): string {
  const counters: number[] = [];
  const lines: string[] = [];
  let prevDepth = -1;

  for (const item of items) {
    const depth = Math.max(item.depth, 0);
    if (depth > prevDepth) counters[depth] = 0;
    counters.length = depth + 1;
    counters[depth] = (counters[depth] ?? 0) + 1;

    const indent = "  ".repeat(depth);
    const marker = item.ordered ? `${counters[depth]}. ` : "- ";
    const body = serializeInline(item.inline).replace(/\n/g, `\n${indent}  `);
    lines.push(`${indent}${marker}${body}`);
    prevDepth = depth;
  }
  return lines.join("\n");
}

function serializeBlock(block: Block): string {
  switch (block.type) {
    case "paragraph":
      return escapeLineStarts(serializeInline(block.inline));
    case "heading":
      return `${"#".repeat(block.level)} ${serializeInline(block.inline)}`;
    case "list":
      return serializeList(block.items);
    case "blockquote":
      return serializeInline(block.inline)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    case "code":
      return `\`\`\`${block.lang}\n${block.text}\n\`\`\``;
    case "table":
      return block.markdown;
    case "html":
      return block.html;
    case "hr":
      return "---";
  }
}

export function serializeMarkdown(blocks: Block[]): string {
  const body = blocks
    .map(serializeBlock)
    .filter((s) => s !== "")
    .join("\n\n");
  return body === "" ? "" : `${body}\n`;
}
