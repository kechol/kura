import { describe, expect, test } from "bun:test";
import { chunkDocument, type DocChunk } from "../src/core/chunker";

const TITLE = "テスト文書";

// Upper bound for overlap (target 240 + adjustment slack)
const OVERLAP_MAX = 400;

/** Return the context-header part of a chunk's text */
function headerOf(chunk: DocChunk): string {
  return chunk.text.slice(0, chunk.text.indexOf("\n\n"));
}

/** Return the raw text of a chunk without the context header */
function rawOf(chunk: DocChunk): string {
  return chunk.text.slice(chunk.text.indexOf("\n\n") + 2);
}

/** End offset of the raw chunk */
function endOf(chunk: DocChunk): number {
  return chunk.startOffset + rawOf(chunk).length;
}

const SENT =
  "SQLite の WAL モードは読み取りと書き込みを並行して実行できるため、ローカルナレッジ検索のような読み取り中心の負荷で高い性能を発揮する。";

/** Long Japanese prose of the given length (a single line without newlines) */
function prose(chars: number): string {
  return SENT.repeat(Math.ceil(chars / SENT.length)).slice(0, chars);
}

/** Multi-line long Japanese prose with many line-end candidates */
function proseLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `${i + 1}行目: ${SENT.slice(0, 40)}`).join("\n");
}

/** Tech-memo style Japanese Markdown fixture (heading hierarchy + code block with Japanese comments + horizontal rule) */
const TECH_MEMO = [
  "# kura 設計メモ",
  "",
  prose(800),
  "",
  "## ストレージ層",
  "",
  prose(700),
  "",
  "```typescript",
  'const db = new Database("kura.db"); // データベースを開く',
  'db.exec("PRAGMA journal_mode = WAL;"); // WAL モードを有効化',
  'db.exec("PRAGMA foreign_keys = ON;"); // 外部キー制約を有効化',
  "```",
  "",
  "### マイグレーション",
  "",
  prose(900),
  "",
  "---",
  "",
  "## 検索パイプライン",
  "",
  prose(1300),
  "",
  "### リランク戦略",
  "",
  prose(1100),
].join("\n");

describe("chunkDocument", () => {
  test("empty string returns an empty array", () => {
    expect(chunkDocument("", TITLE)).toEqual([]);
  });

  test("whitespace/newlines only returns an empty array", () => {
    expect(chunkDocument("   \n\n\t\n", TITLE)).toEqual([]);
    expect(chunkDocument("\n\n\n", TITLE)).toEqual([]);
  });

  test("short text at or below the target size is one chunk + header", () => {
    const content = "短いメモ。\n\nこれは目標サイズよりずっと短い本文である。";
    const chunks = chunkDocument(content, TITLE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.seq).toBe(0);
    expect(chunks[0]!.startOffset).toBe(0);
    expect(chunks[0]!.text).toBe(`# ${TITLE}\n\n${content}`);
  });

  test("exactly 1600 characters is one chunk", () => {
    const content = prose(1600);
    expect(content).toHaveLength(1600);
    const chunks = chunkDocument(content, TITLE);
    expect(chunks).toHaveLength(1);
    expect(rawOf(chunks[0]!)).toBe(content);
  });

  test("long text splits into multiple chunks sized roughly 1600 +- 400", () => {
    const content = proseLines(160); // about 7800 characters
    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.seq).toBe(i); // 0-based sequence
      const len = rawOf(chunk).length;
      expect(len).toBeLessThanOrEqual(2000);
      if (i < chunks.length - 1) expect(len).toBeGreaterThanOrEqual(1200);
    }
    // All chunks together cover the whole body
    expect(chunks[0]!.startOffset).toBe(0);
    expect(endOf(chunks[chunks.length - 1]!)).toBe(content.length);
  });

  test("splits right before a heading near the target position (score priority)", () => {
    const content = `${prose(1560)}\n\n## 後半セクション\n\n${prose(1000)}`;
    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The previous chunk ends exactly at the heading line start
    expect(endOf(chunks[0]!)).toBe(content.indexOf("## 後半セクション"));
    expect(content.slice(endOf(chunks[0]!))).toStartWith("## 後半セクション");
  });

  test("never splits inside a fenced code block", () => {
    const codeLines = Array.from(
      { length: 30 },
      (_, i) => `console.log("処理 ${i + 1}: 日本語のログを出力する");`,
    );
    const codeBlock = `\`\`\`ts\n${codeLines.join("\n")}\n\`\`\``;
    const content = `${prose(1000)}\n\n${codeBlock}\n\n${prose(1000)}`;
    const blockStart = content.indexOf("```ts");
    const blockEnd = content.indexOf("\n```\n") + "\n```\n".length; // start of the line after the closing fence
    expect(blockStart).toBeLessThan(1600);
    expect(blockEnd).toBeGreaterThan(1600); // the block straddles the target position

    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      // Neither start nor end falls inside the block (boundaries are allowed)
      for (const pos of [chunk.startOffset, endOf(chunk)]) {
        expect(pos <= blockStart || pos >= blockEnd).toBe(true);
      }
      // Fences are paired within the raw text
      const fenceCount = (rawOf(chunk).match(/^```/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  test("a document that is only a code block extends to the boundary as one chunk", () => {
    const codeLines = Array.from(
      { length: 60 },
      (_, i) => `print("項目 ${i + 1}: 日本語テキストをまとめて処理する")`,
    );
    const content = `\`\`\`python\n${codeLines.join("\n")}\n\`\`\``;
    expect(content.length).toBeGreaterThan(1600);
    const chunks = chunkDocument(content, TITLE);
    expect(chunks).toHaveLength(1);
    expect(rawOf(chunks[0]!)).toBe(content);
  });

  test("adjacent chunks' raw texts overlap", () => {
    const content = proseLines(160);
    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i + 1 < chunks.length; i++) {
      const overlap = endOf(chunks[i]!) - chunks[i + 1]!.startOffset;
      expect(overlap).toBeGreaterThan(0); // moves back about 240 characters
      expect(overlap).toBeLessThanOrEqual(OVERLAP_MAX);
      // The overlapping text matches
      expect(rawOf(chunks[i]!).slice(-overlap)).toBe(rawOf(chunks[i + 1]!).slice(0, overlap));
    }
  });

  test("startOffset is consistent with the body", () => {
    for (const content of [
      TECH_MEMO,
      proseLines(120),
      `${prose(1560)}\n\n## 章\n\n${prose(800)}`,
    ]) {
      const chunks = chunkDocument(content, TITLE);
      expect(chunks.length).toBeGreaterThanOrEqual(1);
      for (const chunk of chunks) {
        const raw = rawOf(chunk);
        expect(content.slice(chunk.startOffset).startsWith(raw.slice(0, 20))).toBe(true);
        expect(content.slice(chunk.startOffset, chunk.startOffset + raw.length)).toBe(raw);
      }
    }
  });

  test("context headers reflect the nearest heading", () => {
    const content = `## 導入\n\n${prose(200)}\n\n## 設計方針\n\n${prose(3200)}`;
    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The first chunk starts at the heading itself, so only the title
    expect(chunks[0]!.text).toStartWith(`# ${TITLE}\n\n## 導入`);
    // Later chunks carry the nearest heading before their start (設計方針)
    for (const chunk of chunks.slice(1)) {
      expect(chunk.text).toStartWith(`# ${TITLE} > 設計方針\n\n`);
    }
  });

  test("across the tech memo, every chunk header maps to a heading in the document", () => {
    const knownHeadings = [
      "kura 設計メモ",
      "ストレージ層",
      "マイグレーション",
      "検索パイプライン",
      "リランク戦略",
    ];
    const chunks = chunkDocument(TECH_MEMO, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      const m = /^# テスト文書(?: > (.+))?$/.exec(headerOf(chunk));
      expect(m).not.toBeNull();
      if (m?.[1] !== undefined) {
        expect(knownHeadings).toContain(m[1]);
        // The nearest heading precedes the raw chunk start
        expect(TECH_MEMO.lastIndexOf(m[1], chunk.startOffset)).toBeGreaterThanOrEqual(0);
      }
    }
    // The first chunk starts at the document's leading H1, so only the title
    expect(headerOf(chunks[0]!)).toBe(`# ${TITLE}`);
    // Fences stay paired even in chunks containing code blocks
    for (const chunk of chunks) {
      expect((rawOf(chunk).match(/^```/gm) ?? []).length % 2).toBe(0);
    }
  });
});
