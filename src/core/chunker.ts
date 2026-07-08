/** embedding 用チャンク分割（SPEC §5.2）。 */

export interface DocChunk {
  seq: number; // 0 始まり連番
  text: string; // コンテキストヘッダ付きの最終テキスト（embedding 入力）
  startOffset: number; // 本文中の生チャンク開始位置（UTF-16 文字オフセット）
}

const TARGET_SIZE = 1600;
const OVERLAP = 240; // 15%
const WINDOW = 400; // 探索窓 ±400

const HEADING_SCORES = [100, 90, 80] as const; // H1 / H2 / H3
const SCORE_FENCE = 80;
const SCORE_HR = 60;
const SCORE_BLANK = 20;
const SCORE_LINE_END = 1;

const HEADING_RE = /^(#{1,3})(?!#)[ \t]+(\S.*)$/;
const HR_RE = /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/;
const FENCE_OPEN_RE = /^ {0,3}(`{3,})([^`]*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})\s*$/;

interface Line {
  start: number;
  next: number; // 次行の開始位置（最終行は content.length）
  text: string;
}

interface FenceRange {
  start: number; // 開始フェンス行の行頭
  end: number; // 終了フェンス行の次行頭（未閉鎖なら content.length）
}

interface Heading {
  offset: number;
  text: string;
}

interface Analysis {
  positions: number[]; // ブレークポイント候補位置（昇順）
  scores: number[]; // 対応するベーススコア
  headings: Heading[];
  fences: FenceRange[];
}

function splitLines(content: string): Line[] {
  const lines: Line[] = [];
  let pos = 0;
  while (pos < content.length) {
    const nl = content.indexOf("\n", pos);
    if (nl === -1) {
      lines.push({ start: pos, next: content.length, text: content.slice(pos) });
      break;
    }
    lines.push({ start: pos, next: nl + 1, text: content.slice(pos, nl) });
    pos = nl + 1;
  }
  return lines;
}

function detectFences(lines: Line[], contentLength: number): FenceRange[] {
  const fences: FenceRange[] = [];
  let open: { start: number; len: number } | null = null;
  for (const line of lines) {
    if (open === null) {
      const m = FENCE_OPEN_RE.exec(line.text);
      if (m) open = { start: line.start, len: m[1]!.length };
    } else {
      const m = FENCE_CLOSE_RE.exec(line.text);
      if (m && m[1]!.length >= open.len) {
        fences.push({ start: open.start, end: line.next });
        open = null;
      }
    }
  }
  if (open !== null) fences.push({ start: open.start, end: contentLength });
  return fences;
}

function analyze(content: string): Analysis {
  const lines = splitLines(content);
  const fences = detectFences(lines, content.length);
  const headings: Heading[] = [];
  const candidates = new Map<number, number>();
  const add = (pos: number, score: number): void => {
    const cur = candidates.get(pos);
    if (cur === undefined || score > cur) candidates.set(pos, score);
  };

  let fi = 0;
  for (const line of lines) {
    while (fi < fences.length && fences[fi]!.end <= line.start) fi++;
    const fence = fi < fences.length ? fences[fi]! : null;
    if (fence && fence.start <= line.start && line.start < fence.end) continue; // フェンス内では候補を作らない
    add(line.next, SCORE_LINE_END);
    const h = HEADING_RE.exec(line.text);
    if (h) {
      add(line.start, HEADING_SCORES[h[1]!.length - 1]!);
      headings.push({ offset: line.start, text: h[2]!.trim() });
    } else if (HR_RE.test(line.text)) {
      add(line.next, SCORE_HR);
    } else if (line.text.trim() === "") {
      add(line.next, SCORE_BLANK);
    }
  }
  for (const f of fences) {
    add(f.start, SCORE_FENCE);
    add(f.end, SCORE_FENCE);
  }

  const positions = [...candidates.keys()].sort((a, b) => a - b);
  const scores = positions.map((p) => candidates.get(p)!);
  return { positions, scores, headings, fences };
}

/** pos を厳密に内包するフェンスブロックを返す（境界上は null） */
function fenceContaining(pos: number, fences: FenceRange[]): FenceRange | null {
  let lo = 0;
  let hi = fences.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const f = fences[mid]!;
    if (pos <= f.start) hi = mid - 1;
    else if (pos >= f.end) lo = mid + 1;
    else return f;
  }
  return null;
}

function lowerBound(arr: number[], value: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** サロゲートペアの途中かどうか（強制分割位置の補正用） */
function isLowSurrogate(content: string, pos: number): boolean {
  const c = content.charCodeAt(pos);
  return c >= 0xdc00 && c <= 0xdfff;
}

/** チャンク終端位置を決定する。必ず start より前進した位置を返す */
function findCut(content: string, start: number, analysis: Analysis): number {
  const target = start + TARGET_SIZE;
  const lo = Math.max(start + 1, target - WINDOW);
  const hi = Math.min(content.length, target + WINDOW);
  let best = -1;
  let bestScore = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = lowerBound(analysis.positions, lo); i < analysis.positions.length; i++) {
    const pos = analysis.positions[i]!;
    if (pos > hi) break;
    const dist = Math.abs(pos - target);
    const score = analysis.scores[i]! * (1 - (dist / WINDOW) ** 2 * 0.7);
    if (score > bestScore || (score === bestScore && dist < bestDist)) {
      best = pos;
      bestScore = score;
      bestDist = dist;
    }
  }
  if (best >= 0) return best;

  // 窓内に候補なし: 目標位置で強制分割
  let cut = target;
  const fence = fenceContaining(cut, analysis.fences);
  if (fence) {
    // ブロック内なら前進可能な直近境界へずらす
    const before = fence.start > start ? fence.start : -1;
    cut = before >= 0 && target - before <= fence.end - target ? before : fence.end;
  } else if (isLowSurrogate(content, cut)) {
    cut += 1;
  }
  return cut;
}

/** 生チャンク開始位置以前で最も近い見出しからコンテキストヘッダを組み立てる */
function contextHeader(title: string, headings: Heading[], chunkStart: number): string {
  let lo = 0;
  let hi = headings.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (headings[mid]!.offset <= chunkStart) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  const heading = found >= 0 ? headings[found]! : null;
  if (heading === null || heading.offset === chunkStart) return `# ${title}\n\n`;
  return `# ${title} > ${heading.text}\n\n`;
}

/** Markdown 本文を embedding 単位のチャンクに分割する */
export function chunkDocument(content: string, title: string): DocChunk[] {
  if (content.trim() === "") return [];
  const analysis = analyze(content);
  const chunks: DocChunk[] = [];
  let start = 0;
  while (start < content.length) {
    const end =
      content.length - start <= TARGET_SIZE ? content.length : findCut(content, start, analysis);
    chunks.push({
      seq: chunks.length,
      text: contextHeader(title, analysis.headings, start) + content.slice(start, end),
      startOffset: start,
    });
    if (end >= content.length) break;
    // オーバーラップ: 次チャンクの開始を約 240 文字戻す
    let next = end - OVERLAP;
    if (next > start) {
      const fence = fenceContaining(next, analysis.fences);
      if (fence)
        next = fence.end; // ブロック内に落ちたら境界へ（フェンス対を壊さない）
      else if (isLowSurrogate(content, next)) next += 1;
    }
    if (next <= start || next > end) next = end; // 前進保証
    start = next;
  }
  return chunks;
}
