import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { options, render } from "preact";
import { Modal } from "../src/client/components/Modal";

const css = readFileSync(join(import.meta.dir, "../src/client/styles.css"), "utf8");

function themeBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  return css.slice(start, css.indexOf("\n}", start));
}

function token(block: string, name: string): string {
  const value = new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`).exec(block)?.[1];
  if (value === undefined) throw new Error(`--${name} is not a hex color in this theme`);
  return value;
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5]
    .map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi = 0, lo = 0] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

describe("theme tokens meet WCAG AA contrast", () => {
  const themes = {
    light: themeBlock(":root"),
    dark: themeBlock(':root[data-theme="dark"]'),
  };
  const surfaces = ["bg", "bg-panel", "bg-inset"];

  for (const [theme, block] of Object.entries(themes)) {
    for (const surface of surfaces) {
      for (const text of ["text", "text-muted", "accent", "danger"]) {
        test(`${theme}: --${text} on --${surface} reaches 4.5:1`, () => {
          expect(contrast(token(block, text), token(block, surface))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
    for (const surface of ["bg", "bg-panel"]) {
      test(`${theme}: --border-strong on --${surface} reaches 3:1`, () => {
        expect(contrast(token(block, "border-strong"), token(block, surface))).toBeGreaterThan(3);
      });
    }
  }
});

describe("Modal keyboard contract", () => {
  const exposed = ["window", "document", "HTMLElement", "Event", "KeyboardEvent"] as const;
  const saved = new Map<string, unknown>();
  const globals = globalThis as unknown as Record<string, unknown>;
  let container: HTMLElement;
  let activeElement: Element | null = null;

  beforeEach(() => {
    options.requestAnimationFrame = (flush) => setTimeout(flush, 0);
    const { window, document } = parseHTML(
      '<!doctype html><html><body><button id="opener"></button><div id="root"></div></body></html>',
    );
    for (const name of exposed) {
      saved.set(name, globals[name]);
      globals[name] =
        name === "window" || name === "document" ? { window, document }[name] : window[name];
    }
    // linkedom does not track focus, so the test records it the way a browser would
    Object.defineProperty(document, "activeElement", { get: () => activeElement });
    window.HTMLElement.prototype.focus = function focus(this: Element) {
      activeElement = this;
    };
    activeElement = document.getElementById("opener");
    container = document.getElementById("root") as HTMLElement;
  });

  afterEach(async () => {
    render(null, container);
    await new Promise((resolve) => setTimeout(resolve, 0));
    options.requestAnimationFrame = undefined;
    for (const name of exposed) globals[name] = saved.get(name);
    saved.clear();
  });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
  const press = (key: string, shiftKey = false) => {
    const event = new (globals.Event as typeof Event)("keydown", { cancelable: true });
    Object.assign(event, { key, shiftKey, isComposing: false });
    (globals.window as Window).dispatchEvent(event);
    return event;
  };

  test("focus moves in, Tab wraps inside the panel, and closing restores it", async () => {
    render(
      <Modal label="検証" onClose={() => {}}>
        <button id="first" type="button" />
        <button id="last" type="button" />
      </Modal>,
      container,
    );
    await settle();
    expect(activeElement?.id).toBe("first");

    expect(press("Tab", true).defaultPrevented).toBe(true);
    expect(activeElement?.id).toBe("last");
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(activeElement?.id).toBe("first");

    render(null, container);
    await settle();
    expect(activeElement?.id).toBe("opener");
  });

  test("a panel with nothing to focus yet takes focus itself and keeps Tab", async () => {
    render(
      <Modal label="読み込み中" onClose={() => {}}>
        <p>読み込み中…</p>
      </Modal>,
      container,
    );
    await settle();
    expect(activeElement?.getAttribute("role")).toBe("dialog");
    expect(press("Tab").defaultPrevented).toBe(true);
    expect(activeElement?.getAttribute("role")).toBe("dialog");
  });

  test("the backdrop stays out of the Tab order", async () => {
    render(
      <Modal label="検証" onClose={() => {}}>
        <button type="button" />
      </Modal>,
      container,
    );
    await settle();
    expect(container.querySelector<HTMLElement>(".modal-backdrop")?.tabIndex).toBe(-1);
  });
});
