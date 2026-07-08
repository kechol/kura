import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isColorEnabled, renderMarkdown } from "../src/cli/render";

const ESC = "\x1b";

describe("renderMarkdown", () => {
  test("color: false emits no ANSI escapes at all", () => {
    const md = [
      "# 見出し",
      "",
      "**太字**と*斜体*と~~取り消し~~と`コード`。",
      "",
      "- 項目",
      "> 引用",
      "",
      "```ts",
      'const x = "コード";',
      "```",
      "",
      "[リンク](https://example.com) と [[ノート]]",
      "",
      "---",
    ].join("\n");
    const out = renderMarkdown(md, { color: false });
    expect(out).not.toContain(ESC);
  });

  test("color: true decorates headings bold + cyan and strips #", () => {
    const out = renderMarkdown("# 大見出し", { color: true });
    expect(out).toContain(`${ESC}[1m`);
    expect(out).toContain(`${ESC}[36m`);
    expect(out).toContain("大見出し");
    expect(out).not.toContain("#");
  });

  test("H3 and below are bold without color; H5/H6 also use dim", () => {
    const h3 = renderMarkdown("### 小見出し", { color: true });
    expect(h3).toContain(`${ESC}[1m`);
    expect(h3).not.toContain(`${ESC}[36m`);
    const h5 = renderMarkdown("##### 補足見出し", { color: true });
    expect(h5).toContain(`${ESC}[1m${ESC}[2m`);
  });

  test("emphasis syntax is decorated", () => {
    const out = renderMarkdown("**太字**と*斜体*と_下線斜体_と~~取り消し~~", { color: true });
    expect(out).toContain(`${ESC}[1m太字`);
    expect(out).toContain(`${ESC}[3m斜体`);
    expect(out).toContain(`${ESC}[3m下線斜体`);
    expect(out).toContain(`${ESC}[9m取り消し`);
    expect(out).not.toContain("*");
    expect(out).not.toContain("~~");
  });

  test("inline code is decorated yellow and emphasis inside it is ignored", () => {
    const out = renderMarkdown("実行は `bun run **dev**` を使う", { color: true });
    expect(out).toContain(`${ESC}[33mbun run **dev**${ESC}[0m`);
    expect(out).not.toContain("`");
  });

  test("code block content is untouched (emphasis syntax kept as-is)", () => {
    const md = ["```ts", 'const msg = "**強調ではない** _そのまま_";', "```"].join("\n");
    const out = renderMarkdown(md, { color: false });
    expect(out).toBe('  const msg = "**強調ではない** _そのまま_";');
  });

  test("code blocks get 2-space indent + dim; fence lines are not emitted", () => {
    const md = ["```python", "print('こんにちは')", "```"].join("\n");
    const out = renderMarkdown(md, { color: true });
    expect(out).toBe(`  ${ESC}[2mprint('こんにちは')${ESC}[0m`);
    expect(out).not.toContain("```");
    expect(out).not.toContain("python");
  });

  test("code blocks are not wrapped even beyond width", () => {
    const longLine = "const 長い変数名 = 1; // とても長いコメントをここに書いておく";
    const out = renderMarkdown(`\`\`\`\n${longLine}\n\`\`\``, { color: false, width: 20 });
    expect(out).toBe(`  ${longLine}`);
  });

  test("list bullets become • and nesting indentation is preserved", () => {
    const md = ["- 親項目", "  - 子項目", "* アスタリスク", "1. 番号付き"].join("\n");
    const out = renderMarkdown(md, { color: false });
    expect(out).toBe(["• 親項目", "  • 子項目", "• アスタリスク", "1. 番号付き"].join("\n"));
  });

  test("quotes are converted to a │ prefix", () => {
    const out = renderMarkdown("> 引用された文章", { color: false });
    expect(out).toBe("│ 引用された文章");
    const colored = renderMarkdown("> 引用された文章", { color: true });
    expect(colored).toContain(`${ESC}[2m`);
    expect(colored).toContain("│ ");
  });

  test("horizontal rules become ─ repeated to width", () => {
    const out = renderMarkdown("---", { color: false, width: 10 });
    expect(out).toBe("─".repeat(10));
  });

  test("links are underlined with the URL appended; wiki links stay [[display]] in cyan", () => {
    const out = renderMarkdown("[検索](https://example.com) と [[メモ|覚え書き]] と [[日記]]", {
      color: true,
    });
    expect(out).toContain(`${ESC}[4m検索${ESC}[0m (https://example.com)`);
    expect(out).toContain(`${ESC}[36m[[覚え書き]]${ESC}[0m`);
    expect(out).toContain(`${ESC}[36m[[日記]]${ESC}[0m`);
    const plain = renderMarkdown("[検索](https://example.com) と [[メモ|覚え書き]]", {
      color: false,
    });
    expect(plain).toBe("検索 (https://example.com) と [[覚え書き]]");
  });

  test("tables pass through", () => {
    const md = ["| 列A | 列B |", "| --- | --- |", "| **あ** | い |"].join("\n");
    expect(renderMarkdown(md, { color: false })).toBe(md);
  });

  test("wraps at width, counting full-width characters as width 2", () => {
    const out = renderMarkdown("あいうえおかきくけこ", { color: false, width: 10 });
    expect(out).toBe("あいうえお\nかきくけこ");
  });

  test("wrapped list lines get a hanging indent", () => {
    const out = renderMarkdown("- あいうえおかきくけこ", { color: false, width: 12 });
    expect(out).toBe("• あいうえお\n  かきくけこ");
  });
});

describe("isColorEnabled", () => {
  const savedNoColor = process.env.NO_COLOR;

  beforeEach(() => {
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    if (savedNoColor === undefined) {
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = savedNoColor;
    }
  });

  test("false even on a TTY when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    expect(isColorEnabled({ isTTY: true })).toBe(false);
  });

  test("empty NO_COLOR counts as unset and follows the TTY", () => {
    process.env.NO_COLOR = "";
    expect(isColorEnabled({ isTTY: true })).toBe(true);
  });

  test("false when isTTY: false", () => {
    expect(isColorEnabled({ isTTY: false })).toBe(false);
    expect(isColorEnabled({})).toBe(false);
  });

  test("true when isTTY: true and NO_COLOR is unset", () => {
    expect(isColorEnabled({ isTTY: true })).toBe(true);
  });
});
