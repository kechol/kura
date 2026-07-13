import { describe, expect, test } from "bun:test";
import { inlineText, normalizeInline } from "../src/client/editor/model";
import { parseMarkdown } from "../src/client/editor/parse";
import { serializeMarkdown } from "../src/client/editor/serialize";

/**
 * The editor keeps a block model and saves by serializing it, so `parse → serialize`
 * must not drift: a document edited and saved without changes has to come back
 * byte-identical after one normalization pass (docs: browser-ui.md).
 * The fixtures stay Japanese on purpose (testing.md R4).
 */

/** Serializing a re-parse of our own output must be a fixed point */
function stable(markdown: string): string {
  const once = serializeMarkdown(parseMarkdown(markdown));
  const twice = serializeMarkdown(parseMarkdown(once));
  expect(twice).toBe(once);
  return once;
}

describe("editor model (docs: browser-ui.md)", () => {
  test("headings, paragraphs and inline marks round-trip", () => {
    const src = [
      "# SQLite の WAL モード",
      "",
      "WAL は書き込みを **ブロックしません**。*分離レベル* は `READ COMMITTED` 相当です。",
      "",
      "## 注意点",
      "",
      "チェックポイントの ~~遅延~~ 頻度に注意。",
      "",
    ].join("\n");
    expect(stable(src)).toBe(src);
  });

  test("wiki links survive as atomic nodes, not escaped text", () => {
    const src = "詳しくは [[トランザクション設計]] を参照してください。\n";
    const blocks = parseMarkdown(src);
    const inline = blocks[0]?.type === "paragraph" ? blocks[0].inline : [];
    expect(inline.some((n) => n.kind === "wikilink" && n.target === "トランザクション設計")).toBe(
      true,
    );
    expect(stable(src)).toBe(src);
  });

  test("[[link]] typed as plain text becomes a wikilink node", () => {
    const nodes = normalizeInline([
      { kind: "text", text: "詳しくは [[全文検索の設計]] を参照。", marks: [] },
    ]);
    expect(nodes.map((n) => n.kind)).toEqual(["text", "wikilink", "text"]);
    expect(inlineText(nodes)).toBe("詳しくは [[全文検索の設計]] を参照。");
  });

  test("lists keep nesting and ordering", () => {
    const src = ["- 設計", "  - スキーマ", "  - インデックス", "- 実装", ""].join("\n");
    const blocks = parseMarkdown(src);
    expect(blocks[0]?.type).toBe("list");
    if (blocks[0]?.type === "list") {
      expect(blocks[0].items.map((i) => i.depth)).toEqual([0, 1, 1, 0]);
      expect(blocks[0].items.every((i) => !i.ordered)).toBe(true);
    }
    expect(stable(src)).toBe(src);

    const ordered = ["1. 調査", "2. 設計", "3. 実装", ""].join("\n");
    expect(stable(ordered)).toBe(ordered);
  });

  test("an ordered list nested inside a bullet list keeps both markers", () => {
    const src = ["- 手順", "  1. 調査", "  2. 設計", "- 完了", ""].join("\n");
    const blocks = parseMarkdown(src);
    if (blocks[0]?.type === "list") {
      expect(blocks[0].items.map((i) => `${i.depth}${i.ordered ? "o" : "u"}`)).toEqual([
        "0u",
        "1o",
        "1o",
        "0u",
      ]);
    }
    expect(stable(src)).toBe(src);
  });

  test("code fences, tables, blockquotes and rules are preserved verbatim", () => {
    const src = [
      "```sql",
      "SELECT * FROM documents WHERE path = 'db/sqlite';",
      "```",
      "",
      "> 引用文。ここは編集できます。",
      "",
      "| 項目 | 値 |",
      "| --- | --- |",
      "| トークナイザ | vaporetto |",
      "",
      "---",
      "",
      "本文の続き。",
      "",
    ].join("\n");
    const blocks = parseMarkdown(src);
    expect(blocks.map((b) => b.type)).toEqual(["code", "blockquote", "table", "hr", "paragraph"]);
    expect(stable(src)).toBe(src);
  });

  test("mermaid blocks stay code blocks (the renderer upgrades them)", () => {
    const src = ["```mermaid", "graph TD;", "  A-->B;", "```", ""].join("\n");
    const blocks = parseMarkdown(src);
    expect(blocks[0]).toMatchObject({ type: "code", lang: "mermaid" });
    expect(stable(src)).toBe(src);
  });

  test("links and images round-trip", () => {
    const src = "[kura](https://github.com/kechol/kura) と ![図](/img/a.png)。\n";
    expect(stable(src)).toBe(src);
  });

  test("an empty document parses to a single empty paragraph", () => {
    expect(parseMarkdown("").map((b) => b.type)).toEqual(["paragraph"]);
    expect(serializeMarkdown(parseMarkdown(""))).toBe("");
  });

  test("markdown characters typed as literal text are escaped, not re-parsed", () => {
    const nodes = normalizeInline([{ kind: "text", text: "2 * 3 * 4 の計算", marks: [] }]);
    const out = serializeMarkdown([{ id: "x", type: "paragraph", inline: nodes }]);
    const back = parseMarkdown(out);
    expect(back[0]?.type === "paragraph" && inlineText(back[0].inline)).toBe("2 * 3 * 4 の計算");
  });
});
