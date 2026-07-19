import { describe, expect, test } from "bun:test";
import { docExcerpt } from "../src/core/excerpt";

describe("docExcerpt (docs: http-api.md)", () => {
  test("strips headings, emphasis and list markers", () => {
    const md = "# 見出し\n\n- **重要**な項目\n- 次の項目";
    expect(docExcerpt(md, "markdown")).toBe("見出し 重要な項目 次の項目");
  });

  test("drops fenced code blocks, including an unclosed trailing fence", () => {
    const md = "説明文。\n\n```ts\nconst x = 1;\n```\n\n続きの本文。";
    expect(docExcerpt(md, "markdown")).toBe("説明文。 続きの本文。");
    const unclosed = "前置き。\n\n```\nまだ閉じていないコード";
    expect(docExcerpt(unclosed, "markdown")).toBe("前置き。");
  });

  test("wiki links reduce to display / last segment / title", () => {
    expect(docExcerpt("[[パス/タイトル|表示名]] を参照", "markdown")).toBe("表示名 を参照");
    expect(docExcerpt("[[パス/タイトル]] を参照", "markdown")).toBe("タイトル を参照");
    expect(docExcerpt("[[設計方針]] を参照", "markdown")).toBe("設計方針 を参照");
  });

  test("markdown links keep text, images and inline #tags are removed", () => {
    expect(docExcerpt("詳細は [公式](https://example.com) を見る", "markdown")).toBe(
      "詳細は 公式 を見る",
    );
    expect(docExcerpt("図 ![代替](img.png) の後", "markdown")).toBe("図 の後");
    expect(docExcerpt("本文 #tech/db の話", "markdown")).toBe("本文 の話");
  });

  test("front matter block is stripped", () => {
    const md = "---\ntitle: メモ\ntags: [技術]\n---\n本文の先頭。";
    expect(docExcerpt(md, "markdown")).toBe("本文の先頭。");
  });

  test("HTML tags and entities", () => {
    const html =
      "<style>p{color:red}</style><p>段落&amp;本文 <b>強調</b></p><script>alert(1)</script>";
    expect(docExcerpt(html, "html")).toBe("段落&本文 強調");
  });

  test("truncates at max with an ellipsis", () => {
    const long = "あ".repeat(300);
    const out = docExcerpt(long, "markdown");
    expect(out.length).toBe(201); // 200 chars + …
    expect(out.endsWith("…")).toBe(true);
  });

  test("empty / whitespace-only content yields an empty string", () => {
    expect(docExcerpt("", "markdown")).toBe("");
    expect(docExcerpt("   \n\n  ", "markdown")).toBe("");
  });

  test("only scans the first 2000 characters", () => {
    const content = `${"本文".repeat(1100)}末尾マーカー`; // > 2000 chars, marker past the cap
    const out = docExcerpt(content, "markdown");
    expect(out).not.toContain("末尾マーカー");
    expect(out.endsWith("…")).toBe(true);
  });
});
