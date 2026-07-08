/** Wiki リンク・ハッシュタグのパーサ（SPEC §4） */

export interface WikiLink {
  /** [[...]] 内のタイトル部（trim 済み、生のケース保持） */
  target: string;
  /** [[タイトル|表示]] の表示部。無ければ null */
  display: string | null;
}

export interface WikiExtraction {
  /** 出現順。target の小文字比較で重複除去（最初の出現を保持） */
  links: WikiLink[];
  /** normalizeTagPath 適用済み・重複除去済み・出現順 */
  tags: string[];
}

/** タグパスの正規化: 小文字化・前後スラッシュ除去・連続スラッシュ圧縮・各セグメント trim。空になれば null */
export function normalizeTagPath(raw: string): string | null {
  const segments = raw
    .toLowerCase()
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return segments.length > 0 ? segments.join("/") : null;
}

/** [[タイトル]] / [[タイトル|表示]]。タイトル部に [ ] | は含められない */
const LINK_RE = /\[\[([^[\]|\n]*)(?:\|([^[\]\n]*))?\]\]/g;

/** # の直前が行頭・空白・開き括弧のときのみタグ。タグ文字は Unicode 文字・数字・-・_、階層区切りは / */
const TAG_RE = /(?<=^|[\s([{（「『【〔〈《])#([\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)/gu;

/** フェンス開始行: インデント3以内 + ``` / ~~~ 3個以上 + 情報文字列 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** フェンス終了行: フェンス文字の連続のみ（後続は空白可） */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

const LINE_SPLIT_RE = /\r?\n/;

/** フェンスコードブロック外の行を、インラインコードをマスクした状態で列挙する */
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
      // バッククォートフェンスの情報文字列に ` は置けない（CommonMark）
      if (marker.startsWith("~") || !info.includes("`")) {
        fenceChar = marker.charAt(0);
        fenceLen = marker.length;
        continue;
      }
    }
    yield maskInlineCode(line);
  }
}

/** インラインコードスパン（同数のバッククォート対）を ` でマスクする。対にならない ` はそのまま */
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

/** from 以降で長さ n ちょうどのバッククォート連続の開始位置を探す（CommonMark の閉じ規則） */
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

/** 本文から [[リンク]] と #タグ を抽出する（frontmatter 除去済み Markdown 前提） */
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
