import { describe, expect, test } from "bun:test";
import { type KeyStroke, resolveShortcut, SHORTCUTS } from "../src/client/shortcuts";

function stroke(key: string, mods: Partial<Omit<KeyStroke, "key">> = {}): KeyStroke {
  return { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods };
}

function action(e: KeyStroke, pending = false): string | null {
  const hit = resolveShortcut(e, pending);
  return hit.type === "action" ? hit.action : null;
}

describe("resolveShortcut — Ctrl combos", () => {
  test.each([
    ["p", "search"],
    ["n", "new"],
    ["r", "recent"],
    ["h", "home"],
    ["t", "tags"],
  ])("Ctrl+%s → %s", (key, expected) => {
    expect(action(stroke(key, { ctrlKey: true }))).toBe(expected);
  });

  test("Ctrl+Shift+/ → shortcuts (rendered as Ctrl+?)", () => {
    expect(action(stroke("/", { ctrlKey: true, shiftKey: true }))).toBe("shortcuts");
  });

  test("Cmd combos are left to the browser", () => {
    expect(action(stroke("p", { metaKey: true }))).toBeNull();
    expect(action(stroke("p", { ctrlKey: true, metaKey: true }))).toBeNull();
    expect(action(stroke("p", { ctrlKey: true, altKey: true }))).toBeNull();
  });

  test("Ctrl combos win even while a G prefix is pending", () => {
    expect(action(stroke("p", { ctrlKey: true }), true)).toBe("search");
  });
});

describe("resolveShortcut — single keys", () => {
  test.each([
    ["/", "search"],
    ["?", "shortcuts"],
    ["c", "new"],
  ])("%s → %s", (key, expected) => {
    expect(action(stroke(key))).toBe(expected);
  });

  test("shifted letters are different keys", () => {
    expect(action(stroke("C", { shiftKey: true }))).toBeNull();
  });

  test("unbound keys do nothing", () => {
    expect(action(stroke("j"))).toBeNull();
    expect(action(stroke("h"))).toBeNull();
  });
});

describe("resolveShortcut — G sequences", () => {
  test("g opens the prefix; G does not", () => {
    expect(resolveShortcut(stroke("g"), false).type).toBe("prefix");
    expect(resolveShortcut(stroke("G", { shiftKey: true }), false).type).toBe("none");
  });

  test.each([
    ["h", "home"],
    ["d", "docs"],
    ["t", "tags"],
    ["g", "graph"],
    ["s", "stats"],
    ["r", "recent"],
    ["b", "bucket"],
  ])("g %s → %s", (key, expected) => {
    expect(action(stroke(key), true)).toBe(expected);
  });

  test("an unmatched second key falls through to the bare bindings", () => {
    expect(action(stroke("/"), true)).toBe("search");
    expect(action(stroke("x"), true)).toBeNull();
  });
});

test("every binding renders a combo for the shortcut list", () => {
  for (const s of SHORTCUTS) {
    expect(s.bindings.length).toBeGreaterThan(0);
    for (const b of s.bindings) expect(b.combo).not.toBe("");
  }
});
