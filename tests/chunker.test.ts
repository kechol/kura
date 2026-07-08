import { describe, expect, test } from "bun:test";
import { chunkDocument, type DocChunk } from "../src/core/chunker";

const TITLE = "テスト文書";

// オーバーラップの上限（目標 240 + 調整余地）
const OVERLAP_MAX = 400;

/** チャンク text からコンテキストヘッダ部分を返す */
function headerOf(chunk: DocChunk): string {
  return chunk.text.slice(0, chunk.text.indexOf("\n\n"));
}

/** チャンク text からコンテキストヘッダを除いた生テキストを返す */
function rawOf(chunk: DocChunk): string {
  return chunk.text.slice(chunk.text.indexOf("\n\n") + 2);
}

/** 生チャンクの終端オフセット */
function endOf(chunk: DocChunk): number {
  return chunk.startOffset + rawOf(chunk).length;
}

const SENT =
  "SQLite の WAL モードは読み取りと書き込みを並行して実行できるため、ローカルナレッジ検索のような読み取り中心の負荷で高い性能を発揮する。";

/** 指定文字数の日本語長文（改行なしの 1 行） */
function prose(chars: number): string {
  return SENT.repeat(Math.ceil(chars / SENT.length)).slice(0, chars);
}

/** 行末候補を多く含む複数行の日本語長文 */
function proseLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `${i + 1}行目: ${SENT.slice(0, 40)}`).join("\n");
}

/** 技術メモ風の日本語 Markdown fixture（見出し階層 + 日本語コメント入りコードブロック + 水平線） */
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
  test("空文字列は空配列を返す", () => {
    expect(chunkDocument("", TITLE)).toEqual([]);
  });

  test("空白・改行のみは空配列を返す", () => {
    expect(chunkDocument("   \n\n\t\n", TITLE)).toEqual([]);
    expect(chunkDocument("\n\n\n", TITLE)).toEqual([]);
  });

  test("目標サイズ以下の短文は 1 チャンク + ヘッダ", () => {
    const content = "短いメモ。\n\nこれは目標サイズよりずっと短い本文である。";
    const chunks = chunkDocument(content, TITLE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.seq).toBe(0);
    expect(chunks[0]!.startOffset).toBe(0);
    expect(chunks[0]!.text).toBe(`# ${TITLE}\n\n${content}`);
  });

  test("ちょうど 1600 文字は 1 チャンク", () => {
    const content = prose(1600);
    expect(content).toHaveLength(1600);
    const chunks = chunkDocument(content, TITLE);
    expect(chunks).toHaveLength(1);
    expect(rawOf(chunks[0]!)).toBe(content);
  });

  test("長文は複数チャンクに分割され、サイズが概ね 1600±400 に収まる", () => {
    const content = proseLines(160); // 約 7800 文字
    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const [i, chunk] of chunks.entries()) {
      expect(chunk.seq).toBe(i); // 0 始まり連番
      const len = rawOf(chunk).length;
      expect(len).toBeLessThanOrEqual(2000);
      if (i < chunks.length - 1) expect(len).toBeGreaterThanOrEqual(1200);
    }
    // 全チャンクで本文全体をカバーする
    expect(chunks[0]!.startOffset).toBe(0);
    expect(endOf(chunks[chunks.length - 1]!)).toBe(content.length);
  });

  test("目標位置付近の見出し直前で分割される（スコア優先）", () => {
    const content = `${prose(1560)}\n\n## 後半セクション\n\n${prose(1000)}`;
    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 前チャンクの終端が見出し行頭と一致する
    expect(endOf(chunks[0]!)).toBe(content.indexOf("## 後半セクション"));
    expect(content.slice(endOf(chunks[0]!))).toStartWith("## 後半セクション");
  });

  test("フェンスコードブロックの内部では分割されない", () => {
    const codeLines = Array.from(
      { length: 30 },
      (_, i) => `console.log("処理 ${i + 1}: 日本語のログを出力する");`,
    );
    const codeBlock = `\`\`\`ts\n${codeLines.join("\n")}\n\`\`\``;
    const content = `${prose(1000)}\n\n${codeBlock}\n\n${prose(1000)}`;
    const blockStart = content.indexOf("```ts");
    const blockEnd = content.indexOf("\n```\n") + "\n```\n".length; // 終了フェンス行の次行頭
    expect(blockStart).toBeLessThan(1600);
    expect(blockEnd).toBeGreaterThan(1600); // ブロックが目標位置をまたぐ

    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      // 開始・終端ともにブロック内部に落ちない（境界は許容）
      for (const pos of [chunk.startOffset, endOf(chunk)]) {
        expect(pos <= blockStart || pos >= blockEnd).toBe(true);
      }
      // 生テキスト内でフェンスが対になっている
      const fenceCount = (rawOf(chunk).match(/^```/gm) ?? []).length;
      expect(fenceCount % 2).toBe(0);
    }
  });

  test("コードブロックだけの文書は境界まで伸ばして 1 チャンク", () => {
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

  test("隣接チャンクの生テキストがオーバーラップする", () => {
    const content = proseLines(160);
    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i + 1 < chunks.length; i++) {
      const overlap = endOf(chunks[i]!) - chunks[i + 1]!.startOffset;
      expect(overlap).toBeGreaterThan(0); // 約 240 文字戻る
      expect(overlap).toBeLessThanOrEqual(OVERLAP_MAX);
      // 重なり部分のテキストが一致する
      expect(rawOf(chunks[i]!).slice(-overlap)).toBe(rawOf(chunks[i + 1]!).slice(0, overlap));
    }
  });

  test("startOffset が本文と整合する", () => {
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

  test("コンテキストヘッダに直近見出しが反映される", () => {
    const content = `## 導入\n\n${prose(200)}\n\n## 設計方針\n\n${prose(3200)}`;
    const chunks = chunkDocument(content, TITLE);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 先頭チャンクは見出し自体で始まるためタイトルのみ
    expect(chunks[0]!.text).toStartWith(`# ${TITLE}\n\n## 導入`);
    // 2 番目以降は開始位置以前の直近見出し（設計方針）を持つ
    for (const chunk of chunks.slice(1)) {
      expect(chunk.text).toStartWith(`# ${TITLE} > 設計方針\n\n`);
    }
  });

  test("技術メモ全体で各チャンクのヘッダが文書内の見出しに対応する", () => {
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
        // 直近見出しは生チャンク開始位置以前にある
        expect(TECH_MEMO.lastIndexOf(m[1], chunk.startOffset)).toBeGreaterThanOrEqual(0);
      }
    }
    // 先頭チャンクは文書先頭の H1 で始まるためタイトルのみ
    expect(headerOf(chunks[0]!)).toBe(`# ${TITLE}`);
    // コードブロックを含むチャンクでもフェンスが対になっている
    for (const chunk of chunks) {
      expect((rawOf(chunk).match(/^```/gm) ?? []).length % 2).toBe(0);
    }
  });
});
