import { describe, expect, test } from "bun:test";
import { extractWiki, normalizeTagPath } from "../src/core/wiki";

describe("normalizeTagPath", () => {
  test("小文字化する", () => {
    expect(normalizeTagPath("Tech/DB/SQLite")).toBe("tech/db/sqlite");
  });

  test("前後スラッシュを除去し連続スラッシュを圧縮する", () => {
    expect(normalizeTagPath("/tech//db/")).toBe("tech/db");
    expect(normalizeTagPath("///a////b///")).toBe("a/b");
  });

  test("各セグメントを trim する", () => {
    expect(normalizeTagPath(" Tech / DB ")).toBe("tech/db");
    expect(normalizeTagPath("a/　日本語　/b")).toBe("a/日本語/b");
  });

  test("空になる入力は null", () => {
    expect(normalizeTagPath("")).toBeNull();
    expect(normalizeTagPath("   ")).toBeNull();
    expect(normalizeTagPath("///")).toBeNull();
    expect(normalizeTagPath("/ / /")).toBeNull();
  });

  test("日本語タグを保持する", () => {
    expect(normalizeTagPath("技術/データベース")).toBe("技術/データベース");
  });
});

describe("extractWiki: Wiki リンク", () => {
  test("基本形 [[タイトル]] を抽出する", () => {
    const { links } = extractWiki("[[SQLite の WAL モード]] を参照。");
    expect(links).toEqual([{ target: "SQLite の WAL モード", display: null }]);
  });

  test("[[タイトル|表示テキスト]] の表示部を抽出する", () => {
    const { links } = extractWiki("詳細は [[SQLite 公式ドキュメント|公式]] へ。");
    expect(links).toEqual([{ target: "SQLite 公式ドキュメント", display: "公式" }]);
  });

  test("タイトル・表示は trim される", () => {
    const { links } = extractWiki("[[ 議事録 2026-07-07 | 昨日の議事録 ]]");
    expect(links).toEqual([{ target: "議事録 2026-07-07", display: "昨日の議事録" }]);
  });

  test("空タイトルは無視する", () => {
    expect(extractWiki("[[]]").links).toEqual([]);
    expect(extractWiki("[[  ]]").links).toEqual([]);
    expect(extractWiki("[[ | x]]").links).toEqual([]);
  });

  test("表示部が空なら display は null", () => {
    expect(extractWiki("[[メモ|]]").links).toEqual([{ target: "メモ", display: null }]);
    expect(extractWiki("[[メモ| ]]").links).toEqual([{ target: "メモ", display: null }]);
  });

  test("]] を含まない開き括弧は無視する", () => {
    expect(extractWiki("[[未クローズ").links).toEqual([]);
    const { links } = extractWiki("あ [[閉じた]] と [[未クローズ");
    expect(links).toEqual([{ target: "閉じた", display: null }]);
  });

  test("ネスト風は内側だけがリンクになる", () => {
    const { links } = extractWiki("[[外側[[内側]]]]");
    expect(links).toEqual([{ target: "内側", display: null }]);
  });

  test("表示部の 2 個目以降の | は表示テキストに含める", () => {
    const { links } = extractWiki("[[A|B|C]]");
    expect(links).toEqual([{ target: "A", display: "B|C" }]);
  });

  test("target の小文字比較で重複除去し最初の出現を保持する", () => {
    const { links } = extractWiki("[[SQLite]] と [[sqlite]] と [[SQLITE|別名]]");
    expect(links).toEqual([{ target: "SQLite", display: null }]);
  });

  test("複数リンクは出現順に並ぶ", () => {
    const { links } = extractWiki("[[う]] [[あ]]\n[[い]]");
    expect(links.map((l) => l.target)).toEqual(["う", "あ", "い"]);
  });
});

describe("extractWiki: ハッシュタグ", () => {
  test("階層タグを抽出する", () => {
    expect(extractWiki("#tech/db/sqlite").tags).toEqual(["tech/db/sqlite"]);
  });

  test("日本語タグを抽出する", () => {
    const { tags } = extractWiki("メモ: #技術/データベース と #アイデア");
    expect(tags).toEqual(["技術/データベース", "アイデア"]);
  });

  test("数字・ハイフン・アンダースコアを含むタグ", () => {
    expect(extractWiki("#web-dev_2 #2026").tags).toEqual(["web-dev_2", "2026"]);
  });

  test("開き括弧の直後のタグを抽出する", () => {
    const { tags } = extractWiki("結論（#メモ）と補足「#アイデア」と英語(#note)");
    expect(tags).toEqual(["メモ", "アイデア", "note"]);
  });

  test("URL フラグメントや文中の # は拾わない", () => {
    expect(extractWiki("https://example.com/index.html#section").tags).toEqual([]);
    expect(extractWiki("foo#bar と issue#123").tags).toEqual([]);
    expect(extractWiki("[[リンク]]#直後 はタグではない").tags).toEqual([]);
  });

  test("Markdown 見出しはタグではない", () => {
    expect(extractWiki("# 見出し\n## 見出し2").tags).toEqual([]);
    // # の直後に空白がなければ行頭でもタグ
    expect(extractWiki("#見出しではなくタグ").tags).toEqual(["見出しではなくタグ"]);
  });

  test("normalizeTagPath 適用後の値で重複除去する", () => {
    const { tags } = extractWiki("#Tech/DB #tech/db #TECH/DB/sqlite");
    expect(tags).toEqual(["tech/db", "tech/db/sqlite"]);
  });

  test("末尾のスラッシュはタグに含めない", () => {
    expect(extractWiki("#tech/ です").tags).toEqual(["tech"]);
  });

  test("タグは出現順に並ぶ", () => {
    expect(extractWiki("#b #a\n#c #b").tags).toEqual(["b", "a", "c"]);
  });
});

describe("extractWiki: コードブロック無視", () => {
  test("フェンスコードブロック内のリンク・タグは無視する", () => {
    const doc = ["前 [[A]] #before", "```sql", "-- [[B]] #inside", "```", "後 [[C]] #after"].join(
      "\n",
    );
    const { links, tags } = extractWiki(doc);
    expect(links.map((l) => l.target)).toEqual(["A", "C"]);
    expect(tags).toEqual(["before", "after"]);
  });

  test("~~~ フェンスと情報文字列に対応する", () => {
    const doc = ["~~~markdown 例", "[[中身]] #中身", "~~~", "#外side"].join("\n");
    const { links, tags } = extractWiki(doc);
    expect(links).toEqual([]);
    expect(tags).toEqual(["外side"]);
  });

  test("フェンス開始行の情報文字列はタグとして拾わない", () => {
    const doc = ["```js #not-a-tag", "code", "```"].join("\n");
    expect(extractWiki(doc).tags).toEqual([]);
  });

  test("インデントされたフェンス（3 スペース以内）に対応する", () => {
    const doc = ["  ```", "  [[中]] #中", "  ```", "[[外]]"].join("\n");
    const { links, tags } = extractWiki(doc);
    expect(links.map((l) => l.target)).toEqual(["外"]);
    expect(tags).toEqual([]);
  });

  test("閉じないフェンスは末尾まで無視する", () => {
    const doc = ["#先頭", "```", "[[中]] #中", "まだコード"].join("\n");
    const { links, tags } = extractWiki(doc);
    expect(links).toEqual([]);
    expect(tags).toEqual(["先頭"]);
  });

  test("開始より多い本数のフェンスで閉じられる", () => {
    const doc = ["```", "#中", "`````", "#外"].join("\n");
    expect(extractWiki(doc).tags).toEqual(["外"]);
  });

  test("インラインコード内は無視する", () => {
    const { links, tags } = extractWiki("行内の `#tag` や `[[link]]` は無視。 #残る は残る。");
    expect(links).toEqual([]);
    expect(tags).toEqual(["残る"]);
  });

  test("二重バッククォートスパン（` を内包）内も無視する", () => {
    const { tags } = extractWiki("``code ` #inner`` の後の #outer");
    expect(tags).toEqual(["outer"]);
  });

  test("インラインコードの後のリンク・タグは抽出する", () => {
    const { links, tags } = extractWiki("`PRAGMA` の説明は [[WAL]] と #sqlite を参照");
    expect(links.map((l) => l.target)).toEqual(["WAL"]);
    expect(tags).toEqual(["sqlite"]);
  });

  test("対にならないバッククォートはコードにしない", () => {
    const { tags } = extractWiki("これは ` 単独。 #タグ は生きる");
    expect(tags).toEqual(["タグ"]);
  });
});

describe("extractWiki: 統合", () => {
  test("日本語ドキュメントからリンクとタグを抽出する", () => {
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

  test("空文字列・記号のみの入力でも壊れない", () => {
    for (const doc of ["", "\n\n", "[[", "]]", "#", "|", "`", "```", "\r\n"]) {
      expect(extractWiki(doc)).toEqual({ links: [], tags: [] });
    }
  });

  test("CRLF 改行でも動作する", () => {
    const { links, tags } = extractWiki("#a\r\n[[B]]\r\n```\r\n#c\r\n```\r\n");
    expect(tags).toEqual(["a"]);
    expect(links.map((l) => l.target)).toEqual(["B"]);
  });
});

/** 再現可能な擬似乱数（プロパティテスト用） */
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

describe("プロパティベース境界値テスト（SPEC §14）", () => {
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

  test("extractWiki は任意入力で例外を投げず不変条件を満たす", () => {
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
        // 正規化済み（冪等）かつ一意
        expect(normalizeTagPath(tag)).toBe(tag);
        expect(seenTags.has(tag)).toBe(false);
        seenTags.add(tag);
      }
    }
  });

  test("normalizeTagPath は正規形か null を返す（冪等）", () => {
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

  test("極端な入力（長大・タグのみ・リンクのみ）", () => {
    const longTag = `#${"a/".repeat(500)}z`;
    expect(extractWiki(longTag).tags).toEqual([`${"a/".repeat(500)}z`]);

    const manyLinks = Array.from({ length: 200 }, (_, i) => `[[doc-${i}]]`).join(" ");
    expect(extractWiki(manyLinks).links).toHaveLength(200);

    const dupLinks = Array.from({ length: 100 }, () => "[[同じ]]").join("\n");
    expect(extractWiki(dupLinks).links).toHaveLength(1);
  });
});
