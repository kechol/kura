/**
 * Markdown → ANSI ターミナルレンダラ（SPEC §7: 自前実装の軽量レンダラ）。
 * 見出し・強調・コードブロック・リスト・引用・リンクを装飾し、テーブル等はパススルー。
 */

export interface RenderOptions {
  /** false なら ANSI エスケープなしの整形テキスト（既定 true） */
  color?: boolean;
  /** 折り返し幅（既定 80）。コードブロックは折り返さない */
  width?: number;
}

/** 色出力すべきか判定: NO_COLOR が設定されていれば false、stream が TTY でなければ false */
export function isColorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== "") return false;
  return stream.isTTY === true;
}

// ANSI SGR コード（外部依存なしの自前定数）
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

/** color: false 時は装飾を一切付けない identity スタイラーを返す */
function makeStyler(color: boolean): Styler {
  if (!color) return (text) => text;
  return (text, ...styles) => {
    if (styles.length === 0) return text;
    const open = styles.map((s) => SGR[s]).join("");
    // 内側の RESET で外側スタイルが途切れないよう再適用する
    return open + text.replaceAll(RESET, RESET + open) + RESET;
  };
}

/** 全角（East Asian Wide/Fullwidth の簡易判定）なら 2、それ以外は 1 */
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

/** 折り返し単位に分解する。ANSI エスケープは幅 0、全角文字は単独で折り返し可能 */
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
      // SGR シーケンス（`ESC [ ... m`）を幅 0 で直前の語に付ける
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

/** ANSI を幅 0 として width で折り返す。折り返し位置と継続行頭の空白は捨てる */
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

/** content を折り返し、先頭行に firstPrefix、継続行に contPrefix を付ける */
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

/** インライン記法（コード・リンク・強調）を装飾する */
function renderInline(text: string, style: Styler): string {
  // 装飾済みスパンを私用領域文字で退避し、後続の置換から保護する
  const stash: string[] = [];
  const keep = (rendered: string): string => {
    stash.push(rendered);
    return `\uE000${stash.length - 1}\uE001`;
  };
  let out = text;
  // inline code（コード内の強調記法は無視される）
  out = out.replace(/`([^`]+)`/g, (_, code: string) => keep(style(code, "yellow")));
  // Wiki リンク: [[タイトル|表示]] / [[タイトル]]
  out = out.replace(/\[\[([^\][|]+)\|([^\][|]+)\]\]/g, (_, _title: string, disp: string) =>
    keep(style(`[[${disp}]]`, "cyan")),
  );
  out = out.replace(/\[\[([^\][|]+)\]\]/g, (_, title: string) =>
    keep(style(`[[${title}]]`, "cyan")),
  );
  // リンク: [text](url) → 下線 text + (url)
  out = out.replace(/\[([^\][]+)\]\(([^()\s]+)\)/g, (_, label: string, url: string) =>
    keep(`${style(label, "underline")} (${url})`),
  );
  // 強調
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, s: string) => keep(style(s, "bold")));
  out = out.replace(/__([^_]+)__/g, (_, s: string) => keep(style(s, "bold")));
  out = out.replace(/\*([^*]+)\*/g, (_, s: string) => keep(style(s, "italic")));
  out = out.replace(/(?<![\w`])_([^_]+)_(?!\w)/g, (_, s: string) => keep(style(s, "italic")));
  out = out.replace(/~~([^~]+)~~/g, (_, s: string) => keep(style(s, "strike")));
  // 退避したスパンを復元（ネストした退避があるため解決するまで繰り返す）
  while (/\uE000\d+\uE001/.test(out)) {
    out = out.replace(/\uE000(\d+)\uE001/g, (_, i: string) => stash[Number(i)] ?? "");
  }
  return out;
}

/** 見出しレベルごとの装飾（H1/H2 はシアン太字、下位は控えめに） */
const HEADING_STYLES: StyleName[][] = [
  ["bold", "cyan"],
  ["bold", "cyan"],
  ["bold"],
  ["bold"],
  ["bold", "dim"],
  ["bold", "dim"],
];

/** Markdown を ANSI 装飾付きテキストにレンダリングする */
export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  const color = opts.color ?? true;
  const width = opts.width ?? 80;
  const style = makeStyler(color);
  const out: string[] = [];
  let inCodeBlock = false;

  for (const line of md.split(/\r?\n/)) {
    // フェンスコードブロック（言語名は無視、開始/終了行は出力しない）
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
    // 水平線
    if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push(style("─".repeat(width), "dim"));
      continue;
    }
    // 見出し
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const styles = HEADING_STYLES[level - 1] ?? ["bold"];
      const text = renderInline(heading[2] ?? "", style);
      for (const l of wrapPlain(text, width)) out.push(style(l, ...styles));
      continue;
    }
    // テーブルはパススルー（整形・折り返しなし）
    if (/^\s*\|/.test(line)) {
      out.push(line);
      continue;
    }
    // 引用
    const quote = line.match(/^\s*((?:>\s?)+)(.*)$/);
    if (quote) {
      const depth = ((quote[1] ?? "").match(/>/g) ?? []).length;
      const prefix = style("│ ".repeat(depth), "dim");
      const content = style(renderInline(quote[2] ?? "", style), "dim");
      out.push(...wrapWithPrefix(content, width, prefix, prefix, depth * 2));
      continue;
    }
    // リスト（ネストはインデント保持、ビュレットは • に置換）
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
    // 通常段落（未知記法はそのままパススルー）
    out.push(...wrapPlain(renderInline(line, style), width));
  }

  return out.join("\n");
}
