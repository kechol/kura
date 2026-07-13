import { type InlineMark, type InlineNode, normalizeInline } from "./model";

/**
 * Inline model ⇄ contenteditable DOM.
 *
 * Nothing here ever touches innerHTML: the DOM is built node by node from the model, and
 * read back by walking it. That is what keeps a pasted `<script>` (or any HTML a document
 * happens to contain) from becoming live markup in the editor.
 */

const MARK_TAGS: Array<[InlineMark, string]> = [
  // Innermost first: <strong><em><s><code>text</code></s></em></strong>
  ["code", "code"],
  ["strike", "s"],
  ["em", "em"],
  ["strong", "strong"],
];

function renderNode(node: InlineNode): Node {
  switch (node.kind) {
    case "text": {
      let current: Node = document.createTextNode(node.text);
      for (const [mark, tag] of MARK_TAGS) {
        if (!node.marks.includes(mark)) continue;
        const el = document.createElement(tag);
        el.appendChild(current);
        current = el;
      }
      return current;
    }
    case "link": {
      const el = document.createElement("a");
      el.setAttribute("href", node.href);
      for (const child of node.children) el.appendChild(renderNode(child));
      return el;
    }
    case "wikilink": {
      // Rendered as its own source text: editable, and re-recognised by normalizeInline
      const el = document.createElement("span");
      el.className = "wikilink";
      el.textContent = `[[${node.target}]]`;
      return el;
    }
    case "image": {
      const el = document.createElement("img");
      el.setAttribute("src", node.src);
      el.setAttribute("alt", node.alt);
      return el;
    }
    case "br":
      return document.createElement("br");
  }
}

export function renderInlineTo(root: HTMLElement, nodes: InlineNode[]): void {
  root.textContent = "";
  for (const node of nodes) root.appendChild(renderNode(node));
}

const TAG_MARKS: Record<string, InlineMark> = {
  STRONG: "strong",
  B: "strong",
  EM: "em",
  I: "em",
  S: "strike",
  STRIKE: "strike",
  DEL: "strike",
  CODE: "code",
};

function readNodes(parent: Node, marks: InlineMark[], out: InlineNode[]): void {
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out.push({ kind: "text", text: child.textContent ?? "", marks: [...marks] });
      continue;
    }
    if (!(child instanceof HTMLElement)) continue;

    if (child.tagName === "BR") {
      out.push({ kind: "br" });
      continue;
    }
    if (child instanceof HTMLImageElement) {
      out.push({ kind: "image", src: child.getAttribute("src") ?? "", alt: child.alt });
      continue;
    }
    if (child instanceof HTMLAnchorElement) {
      const children: InlineNode[] = [];
      readNodes(child, marks, children);
      out.push({ kind: "link", href: child.getAttribute("href") ?? "", children });
      continue;
    }
    const mark = TAG_MARKS[child.tagName];
    readNodes(child, mark === undefined ? marks : [...marks, mark], out);
  }
}

/** Read a contenteditable element back into inline nodes (canonical form) */
export function readInline(root: HTMLElement): InlineNode[] {
  const out: InlineNode[] = [];
  readNodes(root, [], out);
  return normalizeInline(out);
}

/** Length of a node in caret units: text length, 1 for <br>, 0 for anything else */
function unitLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").length;
  if (node instanceof HTMLElement && node.tagName === "BR") return 1;
  return 0;
}

/** Caret position inside `root`, in characters. null when the selection is elsewhere. */
export function caretOffset(root: HTMLElement): number | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.endContainer)) return null;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let offset = 0;
  let node = walker.nextNode();
  while (node !== null) {
    if (node === range.endContainer) {
      return node.nodeType === Node.TEXT_NODE ? offset + range.endOffset : offset;
    }
    offset += unitLength(node);
    node = walker.nextNode();
  }
  return offset;
}

/** Put the caret `offset` characters into `root` (clamped to its end) */
export function placeCaret(root: HTMLElement, offset: number): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let seen = 0;
  let node = walker.nextNode();
  const range = document.createRange();

  while (node !== null) {
    const len = unitLength(node);
    if (node.nodeType === Node.TEXT_NODE && seen + len >= offset) {
      range.setStart(node, Math.max(offset - seen, 0));
      range.collapse(true);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      return;
    }
    seen += len;
    node = walker.nextNode();
  }

  // Past the end (or an empty block): collapse to the end of the element
  range.selectNodeContents(root);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/** Split inline nodes at a caret offset (Enter) */
export function splitInline(nodes: InlineNode[], offset: number): [InlineNode[], InlineNode[]] {
  const before: InlineNode[] = [];
  const after: InlineNode[] = [];
  let seen = 0;

  for (const node of nodes) {
    const len =
      node.kind === "text"
        ? node.text.length
        : node.kind === "wikilink"
          ? node.target.length + 4
          : node.kind === "br"
            ? 1
            : 0;
    if (seen >= offset) {
      after.push(node);
    } else if (seen + len <= offset) {
      before.push(node);
    } else if (node.kind === "text") {
      const at = offset - seen;
      before.push({ ...node, text: node.text.slice(0, at) });
      after.push({ ...node, text: node.text.slice(at) });
    } else {
      // Atomic node straddling the caret: keep it whole on the left
      before.push(node);
    }
    seen += len;
  }
  return [normalizeInline(before), normalizeInline(after)];
}
