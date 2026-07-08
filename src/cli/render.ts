/**
 * Markdown → ANSI terminal renderer (SPEC §7: lightweight in-house implementation).
 * Decorates headings, emphasis, code blocks, lists, quotes, and links; tables etc. pass through.
 */

export interface RenderOptions {
  /** When false, formatted text without ANSI escapes (default true) */
  color?: boolean;
  /** Wrap width (default 80). Code blocks are never wrapped */
  width?: number;
}

/** Whether to emit color: false when NO_COLOR is set or the stream is not a TTY */
export function isColorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  return stream.isTTY === true;
}

// ANSI SGR codes (in-house constants, no external dependency)
const ESC = "\x1b";
const RESET = `${ESC}[0m`;
const SGR = {
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  underline: `${ESC}[4m`,
  strike: `${ESC}[9m`,
  yellow: `${ESC}[33m`,
  cyan: `${ESC}[36m`,
} as const;

type StyleName = keyof typeof SGR;
type Styler = (text: string, ...styles: StyleName[]) => string;

/** With color: false, returns an identity styler that applies no decoration */
function makeStyler(color: boolean): Styler {
  if (!color) return (text) => text;
  return (text, ...styles) => {
    if (styles.length === 0) return text;
    const open = styles.map((s) => SGR[s]).join("");
    // Re-apply the outer style after inner RESETs so it is not cut off
    return open + text.replaceAll(RESET, RESET + open) + RESET;
  };
}

/** 2 for full-width characters (rough East Asian Wide/Fullwidth check), otherwise 1 */
function charWidth(cp: number): number {
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x2fffd)
  ) {
    return 2;
  }
  return 1;
}

interface Token {
  text: string;
  width: number;
  space: boolean;
}

/** Split into wrap units. ANSI escapes have width 0; full-width chars can wrap individually */
function tokenize(line: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  let wordWidth = 0;
  const flush = () => {
    if (word !== "") {
      tokens.push({ text: word, width: wordWidth, space: false });
      word = "";
      wordWidth = 0;
    }
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? "";
    if (ch === ESC && line[i + 1] === "[") {
      // Attach SGR sequences (`ESC [ ... m`) to the preceding word with width 0
      let j = i + 2;
      while (j < line.length && !/[a-z]/i.test(line[j] ?? "")) j++;
      word += line.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flush();
      tokens.push({ text: " ", width: 1, space: true });
      i++;
      continue;
    }
    const cp = line.codePointAt(i) ?? 0;
    const c = String.fromCodePoint(cp);
    if (charWidth(cp) === 2) {
      flush();
      tokens.push({ text: c, width: 2, space: false });
    } else {
      word += c;
      wordWidth += 1;
    }
    i += c.length;
  }
  flush();
  return tokens;
}

/** Wrap at width, counting ANSI as width 0. Whitespace at wrap points and continuation line starts is dropped */
function wrapPlain(line: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  let currentWidth = 0;
  for (const token of tokenize(line)) {
    if (currentWidth + token.width > width && currentWidth > 0) {
      lines.push(current.trimEnd());
      current = "";
      currentWidth = 0;
      if (token.space) continue;
    }
    if (token.space && currentWidth === 0 && lines.length > 0) continue;
    current += token.text;
    currentWidth += token.width;
  }
  lines.push(current.trimEnd());
  return lines;
}

/** Wrap content, prefixing the first line with firstPrefix and continuation lines with contPrefix */
function wrapWithPrefix(
  content: string,
  width: number,
  firstPrefix: string,
  contPrefix: string,
  prefixWidth: number,
): string[] {
  const available = Math.max(1, width - prefixWidth);
  return wrapPlain(content, available).map((l, i) => (i === 0 ? firstPrefix : contPrefix) + l);
}

/** Decorate inline syntax (code, links, emphasis) */
function renderInline(text: string, style: Styler): string {
  // Stash decorated spans behind private-use characters to protect them from later replacements
  const stash: string[] = [];
  const keep = (rendered: string): string => {
    stash.push(rendered);
    return `\uE000${stash.length - 1}\uE001`;
  };
  let out = text;
  // Inline code (emphasis syntax inside code is ignored)
  out = out.replace(/`([^`]+)`/g, (_, code: string) => keep(style(code, "yellow")));
  // Wiki links: [[title|display]] / [[title]]
  out = out.replace(/\[\[([^\][|]+)\|([^\][|]+)\]\]/g, (_, _title: string, disp: string) =>
    keep(style(`[[${disp}]]`, "cyan")),
  );
  out = out.replace(/\[\[([^\][|]+)\]\]/g, (_, title: string) =>
    keep(style(`[[${title}]]`, "cyan")),
  );
  // Links: [text](url) → underlined text + (url)
  out = out.replace(/\[([^\][]+)\]\(([^()\s]+)\)/g, (_, label: string, url: string) =>
    keep(`${style(label, "underline")} (${url})`),
  );
  // Emphasis
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, s: string) => keep(style(s, "bold")));
  out = out.replace(/__([^_]+)__/g, (_, s: string) => keep(style(s, "bold")));
  out = out.replace(/\*([^*]+)\*/g, (_, s: string) => keep(style(s, "italic")));
  out = out.replace(/(?<![\w`])_([^_]+)_(?!\w)/g, (_, s: string) => keep(style(s, "italic")));
  out = out.replace(/~~([^~]+)~~/g, (_, s: string) => keep(style(s, "strike")));
  // Restore stashed spans (repeat until resolved because stashes can nest)
  while (/\uE000\d+\uE001/.test(out)) {
    out = out.replace(/\uE000(\d+)\uE001/g, (_, i: string) => stash[Number(i)] ?? "");
  }
  return out;
}

/** Decoration per heading level (H1/H2 cyan bold, lower levels more subdued) */
const HEADING_STYLES: StyleName[][] = [
  ["bold", "cyan"],
  ["bold", "cyan"],
  ["bold"],
  ["bold"],
  ["bold", "dim"],
  ["bold", "dim"],
];

/** Render Markdown to ANSI-decorated text */
export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  const color = opts.color ?? true;
  const width = opts.width ?? 80;
  const style = makeStyler(color);
  const out: string[] = [];
  let inCodeBlock = false;

  for (const line of md.split(/\r?\n/)) {
    // Fenced code blocks (language name is ignored; fence lines are not emitted)
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      out.push(`  ${style(line, "dim")}`);
      continue;
    }
    if (line.trim() === "") {
      out.push("");
      continue;
    }
    // Horizontal rules
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(style("─".repeat(width), "dim"));
      continue;
    }
    // Headings
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const styles = HEADING_STYLES[level - 1] ?? ["bold"];
      const text = renderInline(heading[2] ?? "", style);
      for (const l of wrapPlain(text, width)) out.push(style(l, ...styles));
      continue;
    }
    // Tables pass through (no formatting or wrapping)
    if (/^\s*\|/.test(line)) {
      out.push(line);
      continue;
    }
    // Quotes
    const quote = line.match(/^\s*((?:>\s?)+)(.*)$/);
    if (quote) {
      const depth = ((quote[1] ?? "").match(/>/g) ?? []).length;
      const prefix = style("│ ".repeat(depth), "dim");
      const content = style(renderInline(quote[2] ?? "", style), "dim");
      out.push(...wrapWithPrefix(content, width, prefix, prefix, depth * 2));
      continue;
    }
    // Lists (nesting keeps indentation; bullets become •)
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      const indent = bullet[1] ?? "";
      const content = renderInline(bullet[2] ?? "", style);
      out.push(...wrapWithPrefix(content, width, `${indent}• `, `${indent}  `, indent.length + 2));
      continue;
    }
    const ordered = line.match(/^(\s*)(\d+[.)])\s+(.*)$/);
    if (ordered) {
      const indent = ordered[1] ?? "";
      const marker = ordered[2] ?? "";
      const content = renderInline(ordered[3] ?? "", style);
      const first = `${indent}${marker} `;
      const cont = indent + " ".repeat(marker.length + 1);
      out.push(...wrapWithPrefix(content, width, first, cont, indent.length + marker.length + 1));
      continue;
    }
    // Regular paragraphs (unknown syntax passes through as-is)
    out.push(...wrapPlain(renderInline(line, style), width));
  }

  return out.join("\n");
}
