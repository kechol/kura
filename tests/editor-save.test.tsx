import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { parseHTML } from "linkedom";
import { render } from "preact";
import { Router } from "wouter-preact";
import { memoryLocation } from "wouter-preact/memory-location";
import { Editor } from "../src/client/editor/Editor";
import { DocDetail } from "../src/client/pages/DocDetail";

const exposedGlobals = [
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "HTMLDivElement",
  "Event",
  "KeyboardEvent",
] as const;

const originalGlobals = new Map<string, unknown>();
let container: HTMLElement;
const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;

beforeEach(() => {
  const { window, document } = parseHTML(
    '<!doctype html><html><body><div id="root"></div></body></html>',
  );
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of exposedGlobals) {
    originalGlobals.set(name, globals[name]);
    globals[name] =
      name === "window" || name === "document" ? { window, document }[name] : window[name];
  }
  Object.assign(document, { execCommand: () => true });
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  } as unknown as Storage;
  container = document.getElementById("root") as HTMLElement;
});

afterEach(() => {
  render(null, container);
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalStorage;
  const globals = globalThis as unknown as Record<string, unknown>;
  for (const name of exposedGlobals) globals[name] = originalGlobals.get(name);
  originalGlobals.clear();
});

async function settle(): Promise<void> {
  await Promise.resolve();
  await Bun.sleep(0);
}

async function waitFor(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 500;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(5);
    }
  }
}

function editBody(text: string): void {
  const editable = container.querySelector<HTMLElement>(".editor-block");
  if (!editable) throw new Error("editor did not render a contenteditable block");
  editable.textContent = text;
  editable.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("Editor save lifecycle", () => {
  test("a failed metadata refresh keeps the dirty document editor available", async () => {
    let reads = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/related"))
        return Response.json({ outlinks: [], backlinks: [], twoHop: [] });
      if (url.endsWith("/favorite")) return Response.json({ favorite: true });
      if (init?.method === "PUT") throw new Error("保存できません");
      if (++reads > 1) throw new Error("再読込できません");
      return Response.json({
        key: "aaaaaaaa",
        title: "検証文書",
        path: "",
        bucket: "main",
        tags: [],
        aliases: [],
        content_type: "markdown",
        content: "初期本文\n",
        created_at: "2026-09-21 00:00:00",
        updated_at: "2026-09-21 00:00:00",
        favorite: false,
      });
    }) as typeof fetch;
    const location = memoryLocation({ path: "/docs/aaaaaaaa" });
    render(
      <Router hook={location.hook}>
        <DocDetail docKey="aaaaaaaa" />
      </Router>,
      container,
    );
    await waitFor(() => expect(container.querySelector(".editor-block")).not.toBeNull());
    const title = container.querySelector<HTMLElement>(".doc-title");
    if (!title) throw new Error("document title did not render");
    title.textContent = "失敗するタイトル変更";
    title.dispatchEvent(new Event("blur", { bubbles: true }));
    await waitFor(() => expect(container.querySelector(".save-status.error")).not.toBeNull());
    expect(container.querySelector("button.save-status")).toBeNull();
    editBody("失敗しても失わない本文");
    container.querySelector<HTMLButtonElement>(".favorite-toggle")?.click();
    await waitFor(() => expect(reads).toBe(2));
    await settle();
    expect(container.querySelector(".editor-block")?.textContent).toBe("失敗しても失わない本文");
    expect(container.textContent).toContain("再読込できません");
  });

  test("unmount before the debounce persists the latest body", async () => {
    const saves: string[] = [];
    render(
      <Editor
        initial="初期本文\n"
        resolve={() => null}
        onSave={async (markdown) => {
          saves.push(markdown);
        }}
      />,
      container,
    );
    await settle();

    editBody("遷移直前の本文");
    await settle();
    render(null, container);
    await settle();

    expect(saves).toEqual(["遷移直前の本文\n"]);
  });

  test("serializes delayed saves and persists edits made during the request", async () => {
    const calls: string[] = [];
    const releases: Array<() => void> = [];
    let persisted = "初期本文\n";
    render(
      <Editor
        initial={persisted}
        resolve={() => null}
        autosaveMs={1}
        onSave={(markdown) => {
          calls.push(markdown);
          return new Promise<void>((resolve) => {
            releases.push(() => {
              persisted = markdown;
              resolve();
            });
          });
        }}
      />,
      container,
    );
    await settle();

    editBody("最初の変更");
    await waitFor(() => expect(calls).toHaveLength(1));
    editBody("応答待ち中の最新変更");
    await Bun.sleep(10);
    expect(calls).toHaveLength(1);

    releases[0]?.();
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toBe("応答待ち中の最新変更\n");
    releases[1]?.();
    await waitFor(() => expect(persisted).toBe("応答待ち中の最新変更\n"));
  });

  test("keeps failed content and retries it on demand", async () => {
    const statuses: string[] = [];
    const calls: string[] = [];
    let attempts = 0;
    const onSave = async (markdown: string): Promise<void> => {
      calls.push(markdown);
      attempts++;
      if (attempts === 1) throw new Error("一時的な保存失敗");
    };
    const editor = (retryToken: number) => (
      <Editor
        initial="初期本文\n"
        resolve={() => null}
        autosaveMs={1}
        retryToken={retryToken}
        onStatus={(status) => statuses.push(status)}
        onSave={onSave}
      />
    );
    render(editor(0), container);
    await settle();

    editBody("失敗後も保持する本文");
    await waitFor(() => expect(statuses).toContain("error"));
    render(editor(1), container);
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls).toEqual(["失敗後も保持する本文\n", "失敗後も保持する本文\n"]);
    await waitFor(() => expect(statuses.at(-1)).toBe("saved"));
  });

  test("a metadata rerender does not replace a dirty editor with stale server content", async () => {
    const saves: string[] = [];
    const view = (initial: string) => (
      <Editor
        initial={initial}
        resolve={() => null}
        onSave={async (markdown) => {
          saves.push(markdown);
        }}
      />
    );
    render(view("サーバー上の旧本文\n"), container);
    await settle();
    editBody("メタ情報更新中の最新本文");
    await settle();

    render(view("メタ情報応答に含まれた旧本文\n"), container);
    await settle();
    expect(container.querySelector(".editor-block")?.textContent).toBe("メタ情報更新中の最新本文");
    render(null, container);
    await settle();
    expect(saves).toEqual(["メタ情報更新中の最新本文\n"]);
  });

  test("never saves document A content through document B's callback", async () => {
    const calls: Array<{ key: string; markdown: string }> = [];
    render(
      <Editor
        key="文書A"
        initial="A の初期本文\n"
        resolve={() => null}
        onSave={async (markdown) => {
          calls.push({ key: "文書A", markdown });
        }}
      />,
      container,
    );
    await settle();
    editBody("A の最新本文");
    await settle();

    render(
      <Editor
        key="文書B"
        initial="B の初期本文\n"
        resolve={() => null}
        onSave={async (markdown) => {
          calls.push({ key: "文書B", markdown });
        }}
      />,
      container,
    );
    await settle();
    editBody("B の最新本文");
    await settle();
    render(null, container);
    await settle();

    expect(calls).toEqual([
      { key: "文書A", markdown: "A の最新本文\n" },
      { key: "文書B", markdown: "B の最新本文\n" },
    ]);
  });

  test("IME composition saves only the completed Japanese input", async () => {
    const saves: string[] = [];
    render(
      <Editor
        initial="初期本文\n"
        resolve={() => null}
        onSave={async (markdown) => {
          saves.push(markdown);
        }}
      />,
      container,
    );
    await settle();
    const editable = container.querySelector<HTMLElement>(".editor-block");
    if (!editable) throw new Error("editor did not render a contenteditable block");

    editable.textContent = "にほんご変換中";
    const composingInput = new Event("input", { bubbles: true });
    Object.defineProperty(composingInput, "isComposing", { value: true });
    editable.dispatchEvent(composingInput);
    editable.textContent = "日本語変換済み";
    editable.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    render(null, container);
    await settle();

    expect(saves).toEqual(["日本語変換済み\n"]);
  });
});
