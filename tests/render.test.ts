import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isColorEnabled, renderMarkdown } from "../src/cli/render";

const ESC = "\x1b";

describe("renderMarkdown", () => {
  test("color: false で ANSI エスケープを一切含まない", () => {
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

  test("color: true で見出しに太字 + シアンが付き # は除去される", () => {
    const out = renderMarkdown("# 大見出し", { color: true });
    expect(out).toContain(`${ESC}[1m`);
    expect(out).toContain(`${ESC}[36m`);
    expect(out).toContain("大見出し");
    expect(out).not.toContain("#");
  });

  test("H3 以降は色なし太字、H5/H6 は dim 併用", () => {
    const h3 = renderMarkdown("### 小見出し", { color: true });
    expect(h3).toContain(`${ESC}[1m`);
    expect(h3).not.toContain(`${ESC}[36m`);
    const h5 = renderMarkdown("##### 補足見出し", { color: true });
    expect(h5).toContain(`${ESC}[1m${ESC}[2m`);
  });

  test("強調記法が装飾される", () => {
    const out = renderMarkdown("**太字**と*斜体*と_下線斜体_と~~取り消し~~", { color: true });
    expect(out).toContain(`${ESC}[1m太字`);
    expect(out).toContain(`${ESC}[3m斜体`);
    expect(out).toContain(`${ESC}[3m下線斜体`);
    expect(out).toContain(`${ESC}[9m取り消し`);
    expect(out).not.toContain("*");
    expect(out).not.toContain("~~");
  });

  test("インラインコードは黄色で装飾され、内部の強調記法は無視される", () => {
    const out = renderMarkdown("実行は `bun run **dev**` を使う", { color: true });
    expect(out).toContain(`${ESC}[33mbun run **dev**${ESC}[0m`);
    expect(out).not.toContain("`");
  });

  test("コードブロックの内容が加工されない（強調記法もそのまま）", () => {
    const md = ["```ts", 'const msg = "**強調ではない** _そのまま_";', "```"].join("\n");
    const out = renderMarkdown(md, { color: false });
    expect(out).toBe('  const msg = "**強調ではない** _そのまま_";');
  });

  test("コードブロックは 2 スペースインデント + dim 装飾、フェンス行は出力しない", () => {
    const md = ["```python", "print('こんにちは')", "```"].join("\n");
    const out = renderMarkdown(md, { color: true });
    expect(out).toBe(`  ${ESC}[2mprint('こんにちは')${ESC}[0m`);
    expect(out).not.toContain("```");
    expect(out).not.toContain("python");
  });

  test("コードブロックは width を超えても折り返さない", () => {
    const longLine = "const 長い変数名 = 1; // とても長いコメントをここに書いておく";
    const out = renderMarkdown(`\`\`\`\n${longLine}\n\`\`\``, { color: false, width: 20 });
    expect(out).toBe(`  ${longLine}`);
  });

  test("リストのビュレットが • に置換されネストのインデントが保持される", () => {
    const md = ["- 親項目", "  - 子項目", "* アスタリスク", "1. 番号付き"].join("\n");
    const out = renderMarkdown(md, { color: false });
    expect(out).toBe(["• 親項目", "  • 子項目", "• アスタリスク", "1. 番号付き"].join("\n"));
  });

  test("引用は │ プレフィックスに変換される", () => {
    const out = renderMarkdown("> 引用された文章", { color: false });
    expect(out).toBe("│ 引用された文章");
    const colored = renderMarkdown("> 引用された文章", { color: true });
    expect(colored).toContain(`${ESC}[2m`);
    expect(colored).toContain("│ ");
  });

  test("水平線は width 分の ─ になる", () => {
    const out = renderMarkdown("---", { color: false, width: 10 });
    expect(out).toBe("─".repeat(10));
  });

  test("リンクは下線 + URL 併記、Wiki リンクは [[表示]] のままシアン強調", () => {
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

  test("テーブルはパススルーされる", () => {
    const md = ["| 列A | 列B |", "| --- | --- |", "| **あ** | い |"].join("\n");
    expect(renderMarkdown(md, { color: false })).toBe(md);
  });

  test("width で折り返され全角文字は幅 2 として数えられる", () => {
    const out = renderMarkdown("あいうえおかきくけこ", { color: false, width: 10 });
    expect(out).toBe("あいうえお\nかきくけこ");
  });

  test("リストの折り返し行はぶら下げインデントされる", () => {
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

  test("NO_COLOR 設定時は TTY でも false", () => {
    process.env.NO_COLOR = "1";
    expect(isColorEnabled({ isTTY: true })).toBe(false);
  });

  test("NO_COLOR が空文字なら無効扱いで TTY に従う", () => {
    process.env.NO_COLOR = "";
    expect(isColorEnabled({ isTTY: true })).toBe(true);
  });

  test("isTTY: false なら false", () => {
    expect(isColorEnabled({ isTTY: false })).toBe(false);
    expect(isColorEnabled({})).toBe(false);
  });

  test("isTTY: true + NO_COLOR なしなら true", () => {
    expect(isColorEnabled({ isTTY: true })).toBe(true);
  });
});
