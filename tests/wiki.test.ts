import { describe, expect, test } from "bun:test";
import { extractWiki, normalizeTagPath } from "../src/core/wiki";

describe("normalizeTagPath", () => {
  test("lowercases", () => {
    expect(normalizeTagPath("Tech/DB/SQLite")).toBe("tech/db/sqlite");
  });

  test("strips leading/trailing slashes and collapses repeated slashes", () => {
    expect(normalizeTagPath("/tech//db/")).toBe("tech/db");
    expect(normalizeTagPath("///a////b///")).toBe("a/b");
  });

  test("trims each segment", () => {
    expect(normalizeTagPath(" Tech / DB ")).toBe("tech/db");
    expect(normalizeTagPath("a/　日本語　/b")).toBe("a/日本語/b");
  });

  test("input that normalizes to empty returns null", () => {
    expect(normalizeTagPath("")).toBeNull();
    expect(normalizeTagPath("   ")).toBeNull();
    expect(normalizeTagPath("///")).toBeNull();
    expect(normalizeTagPath("/ / /")).toBeNull();
  });

  test("preserves Japanese tags", () => {
    expect(normalizeTagPath("技術/データベース")).toBe("技術/データベース");
  });
});

describe("extractWiki: wiki links", () => {
  test("extracts the basic [[title]] form", () => {
    const { links } = extractWiki("[[SQLite の WAL モード]] を参照。");
    expect(links).toEqual([{ target: "SQLite の WAL モード", display: null }]);
  });

  test("extracts the display part of [[title|display text]]", () => {
    const { links } = extractWiki("詳細は [[SQLite 公式ドキュメント|公式]] へ。");
    expect(links).toEqual([{ target: "SQLite 公式ドキュメント", display: "公式" }]);
  });

  test("title and display are trimmed", () => {
    const { links } = extractWiki("[[ 議事録 2026-07-07 | 昨日の議事録 ]]");
    expect(links).toEqual([{ target: "議事録 2026-07-07", display: "昨日の議事録" }]);
  });

  test("ignores empty titles", () => {
    expect(extractWiki("[[]]").links).toEqual([]);
    expect(extractWiki("[[  ]]").links).toEqual([]);
    expect(extractWiki("[[ | x]]").links).toEqual([]);
  });

  test("display is null when the display part is empty", () => {
    expect(extractWiki("[[メモ|]]").links).toEqual([{ target: "メモ", display: null }]);
    expect(extractWiki("[[メモ| ]]").links).toEqual([{ target: "メモ", display: null }]);
  });

  test("ignores opening brackets without a closing ]]", () => {
    expect(extractWiki("[[未クローズ").links).toEqual([]);
    const { links } = extractWiki("あ [[閉じた]] と [[未クローズ");
    expect(links).toEqual([{ target: "閉じた", display: null }]);
  });

  test("nested-looking links: only the inner one becomes a link", () => {
    const { links } = extractWiki("[[外側[[内側]]]]");
    expect(links).toEqual([{ target: "内側", display: null }]);
  });

  test("second and later | characters stay in the display text", () => {
    const { links } = extractWiki("[[A|B|C]]");
    expect(links).toEqual([{ target: "A", display: "B|C" }]);
  });

  test("deduplicates by lowercase target, keeping the first occurrence", () => {
    const { links } = extractWiki("[[SQLite]] と [[sqlite]] と [[SQLITE|別名]]");
    expect(links).toEqual([{ target: "SQLite", display: null }]);
  });

  test("multiple links keep their order of appearance", () => {
    const { links } = extractWiki("[[う]] [[あ]]\n[[い]]");
    expect(links.map((l) => l.target)).toEqual(["う", "あ", "い"]);
  });
});

describe("extractWiki: hashtags", () => {
  test("extracts hierarchical tags", () => {
    expect(extractWiki("#tech/db/sqlite").tags).toEqual(["tech/db/sqlite"]);
  });

  test("extracts Japanese tags", () => {
    const { tags } = extractWiki("メモ: #技術/データベース と #アイデア");
    expect(tags).toEqual(["技術/データベース", "アイデア"]);
  });

  test("tags with digits, hyphens, and underscores", () => {
    expect(extractWiki("#web-dev_2 #2026").tags).toEqual(["web-dev_2", "2026"]);
  });

  test("extracts tags right after opening brackets", () => {
    const { tags } = extractWiki("結論（#メモ）と補足「#アイデア」と英語(#note)");
    expect(tags).toEqual(["メモ", "アイデア", "note"]);
  });

  test("does not pick up URL fragments or mid-word #", () => {
    expect(extractWiki("https://example.com/index.html#section").tags).toEqual([]);
    expect(extractWiki("foo#bar と issue#123").tags).toEqual([]);
    expect(extractWiki("[[リンク]]#直後 はタグではない").tags).toEqual([]);
  });

  test("Markdown headings are not tags", () => {
    expect(extractWiki("# 見出し\n## 見出し2").tags).toEqual([]);
    // Without a space after #, it is a tag even at line start
    expect(extractWiki("#見出しではなくタグ").tags).toEqual(["見出しではなくタグ"]);
  });

  test("deduplicates on the normalizeTagPath result", () => {
    const { tags } = extractWiki("#Tech/DB #tech/db #TECH/DB/sqlite");
    expect(tags).toEqual(["tech/db", "tech/db/sqlite"]);
  });

  test("trailing slashes are not part of the tag", () => {
    expect(extractWiki("#tech/ です").tags).toEqual(["tech"]);
  });

  test("tags keep their order of appearance", () => {
    expect(extractWiki("#b #a\n#c #b").tags).toEqual(["b", "a", "c"]);
  });
});

describe("extractWiki: code blocks are ignored", () => {
  test("links and tags inside fenced code blocks are ignored", () => {
    const doc = ["前 [[A]] #before", "```sql", "-- [[B]] #inside", "```", "後 [[C]] #after"].join(
      "\n",
    );
    const { links, tags } = extractWiki(doc);
    expect(links.map((l) => l.target)).toEqual(["A", "C"]);
    expect(tags).toEqual(["before", "after"]);
  });

  test("supports ~~~ fences and info strings", () => {
    const doc = ["~~~markdown 例", "[[中身]] #中身", "~~~", "#外side"].join("\n");
    const { links, tags } = extractWiki(doc);
    expect(links).toEqual([]);
    expect(tags).toEqual(["外side"]);
  });

  test("info strings on fence-opening lines are not tags", () => {
    const doc = ["```js #not-a-tag", "code", "```"].join("\n");
    expect(extractWiki(doc).tags).toEqual([]);
  });

  test("supports indented fences (up to 3 spaces)", () => {
    const doc = ["  ```", "  [[中]] #中", "  ```", "[[外]]"].join("\n");
    const { links, tags } = extractWiki(doc);
    expect(links.map((l) => l.target)).toEqual(["外"]);
    expect(tags).toEqual([]);
  });

  test("unclosed fences are ignored to the end", () => {
    const doc = ["#先頭", "```", "[[中]] #中", "まだコード"].join("\n");
    const { links, tags } = extractWiki(doc);
    expect(links).toEqual([]);
    expect(tags).toEqual(["先頭"]);
  });

  test("a longer fence run can close a shorter opening", () => {
    const doc = ["```", "#中", "`````", "#外"].join("\n");
    expect(extractWiki(doc).tags).toEqual(["外"]);
  });

  test("ignores inline code", () => {
    const { links, tags } = extractWiki("行内の `#tag` や `[[link]]` は無視。 #残る は残る。");
    expect(links).toEqual([]);
    expect(tags).toEqual(["残る"]);
  });

  test("ignores double-backtick spans (containing `) too", () => {
    const { tags } = extractWiki("``code ` #inner`` の後の #outer");
    expect(tags).toEqual(["outer"]);
  });

  test("extracts links and tags after inline code", () => {
    const { links, tags } = extractWiki("`PRAGMA` の説明は [[WAL]] と #sqlite を参照");
    expect(links.map((l) => l.target)).toEqual(["WAL"]);
    expect(tags).toEqual(["sqlite"]);
  });

  test("unpaired backticks do not start code", () => {
    const { tags } = extractWiki("これは ` 単独。 #タグ は生きる");
    expect(tags).toEqual(["タグ"]);
  });
});

describe("extractWiki: integration", () => {
  test("extracts links and tags from a Japanese document", () => {
    const doc = [
      "# SQLite の WAL モード",
      "",
      "[[Write-Ahead Logging]] は SQLite のジャーナルモード（詳細は [[SQLite 公式ドキュメント|公式]] を参照）。",
      "",
      "#技術/データベース #tech/db/sqlite",
      "",
      "```sql",
      "-- ここは無視 #ignored [[無視リンク]]",
      "PRAGMA journal_mode = WAL;",
      "```",
      "",
      "インラインの `#not-a-tag` や `[[not-a-link]]` も無視。ただし #性能 は抽出。",
      "https://example.com/docs#fragment はタグではない。",
    ].join("\n");
    const { links, tags } = extractWiki(doc);
    expect(links).toEqual([
      { target: "Write-Ahead Logging", display: null },
      { target: "SQLite 公式ドキュメント", display: "公式" },
    ]);
    expect(tags).toEqual(["技術/データベース", "tech/db/sqlite", "性能"]);
  });

  test("does not break on empty or symbol-only input", () => {
    for (const doc of ["", "\n\n", "[[", "]]", "#", "|", "`", "```", "\r\n"]) {
      expect(extractWiki(doc)).toEqual({ links: [], tags: [] });
    }
  });

  test("works with CRLF line endings", () => {
    const { links, tags } = extractWiki("#a\r\n[[B]]\r\n```\r\n#c\r\n```\r\n");
    expect(tags).toEqual(["a"]);
    expect(links.map((l) => l.target)).toEqual(["B"]);
  });
});

/** Reproducible pseudo-random generator (for property tests) */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property-based boundary tests (SPEC §14)", () => {
  const PIECES = [
    "[[",
    "]]",
    "|",
    "#",
    "/",
    "`",
    "``",
    "```",
    "~~~",
    "\n",
    " ",
    "　",
    "abc",
    "テスト",
    "技術",
    "-",
    "_",
    "（",
    "「",
    "9",
    "WAL",
  ];

  test("extractWiki never throws and upholds invariants on arbitrary input", () => {
    const rand = mulberry32(20260708);
    for (let iter = 0; iter < 300; iter++) {
      let doc = "";
      const n = Math.floor(rand() * 40);
      for (let i = 0; i < n; i++) doc += PIECES[Math.floor(rand() * PIECES.length)] ?? "";

      const { links, tags } = extractWiki(doc);

      const seenTargets = new Set<string>();
      for (const link of links) {
        expect(link.target).not.toBe("");
        expect(link.target).toBe(link.target.trim());
        expect(link.target).not.toMatch(/[[\]|\n]/);
        expect(seenTargets.has(link.target.toLowerCase())).toBe(false);
        seenTargets.add(link.target.toLowerCase());
        if (link.display !== null) {
          expect(link.display).not.toBe("");
          expect(link.display).toBe(link.display.trim());
        }
      }

      const seenTags = new Set<string>();
      for (const tag of tags) {
        // Already normalized (idempotent) and unique
        expect(normalizeTagPath(tag)).toBe(tag);
        expect(seenTags.has(tag)).toBe(false);
        seenTags.add(tag);
      }
    }
  });

  test("normalizeTagPath returns a normal form or null (idempotent)", () => {
    const rand = mulberry32(42);
    const chars = ["/", " ", "　", "A", "b", "テ", "-", "_", "9"];
    for (let iter = 0; iter < 300; iter++) {
      let raw = "";
      const n = Math.floor(rand() * 15);
      for (let i = 0; i < n; i++) raw += chars[Math.floor(rand() * chars.length)] ?? "";

      const result = normalizeTagPath(raw);
      if (result === null) continue;
      expect(result).toBe(result.toLowerCase());
      expect(result.startsWith("/")).toBe(false);
      expect(result.endsWith("/")).toBe(false);
      expect(result.includes("//")).toBe(false);
      for (const seg of result.split("/")) {
        expect(seg.length).toBeGreaterThan(0);
        expect(seg).toBe(seg.trim());
      }
      expect(normalizeTagPath(result)).toBe(result);
    }
  });

  test("extreme inputs (very long, tags only, links only)", () => {
    const longTag = `#${"a/".repeat(500)}z`;
    expect(extractWiki(longTag).tags).toEqual([`${"a/".repeat(500)}z`]);

    const manyLinks = Array.from({ length: 200 }, (_, i) => `[[doc-${i}]]`).join(" ");
    expect(extractWiki(manyLinks).links).toHaveLength(200);

    const dupLinks = Array.from({ length: 100 }, () => "[[同じ]]").join("\n");
    expect(extractWiki(dupLinks).links).toHaveLength(1);
  });
});
