import { useEffect, useRef } from "preact/hooks";

/**
 * Global keyboard shortcuts.
 *
 * Two binding styles coexist, and both are needed (docs: browser-ui.md):
 *
 * - **Ctrl combos, never Cmd**: on macOS the browser and the OS reserve Cmd+T
 *   (new tab), Cmd+H (hide app) and Cmd+R (reload), and a web page cannot take
 *   them back. Ctrl+<letter> is effectively free there; on Windows / Linux the
 *   browser still owns Ctrl+T and Ctrl+N — documented as a known limitation
 *   rather than worked around.
 * - **Single keys and G sequences** (Gmail / GitHub style): active only while
 *   no field has focus, so they collide with nothing on any platform. `/`,
 *   `?` and `C` alias the Ctrl combos; `G → <key>` navigates between screens.
 */

export type ShortcutAction =
  | "search"
  | "shortcuts"
  | "recent"
  | "home"
  | "tags"
  | "new"
  | "docs"
  | "graph"
  | "stats"
  | "bucket";

export interface KeyBinding {
  /** "ctrl" = Ctrl+key, "bare" = the key alone, "seq" = the key after a G prefix */
  kind: "ctrl" | "bare" | "seq";
  /** event.key — "ctrl" compares case-insensitively, "bare" / "seq" exactly */
  key: string;
  /** "ctrl" only; a bare key already encodes shift in event.key */
  shift?: boolean;
  /** Rendered in the shortcut list */
  combo: string;
}

export interface Shortcut {
  action: ShortcutAction;
  bindings: KeyBinding[];
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  {
    action: "search",
    label: "検索する",
    bindings: [
      { kind: "ctrl", key: "p", combo: "Ctrl + P" },
      { kind: "bare", key: "/", combo: "/" },
    ],
  },
  {
    action: "new",
    label: "新しいドキュメントを作成",
    bindings: [
      { kind: "ctrl", key: "n", combo: "Ctrl + N" },
      { kind: "bare", key: "c", combo: "C" },
    ],
  },
  {
    action: "shortcuts",
    label: "ショートカット一覧",
    bindings: [
      { kind: "ctrl", key: "/", shift: true, combo: "Ctrl + ?" },
      { kind: "bare", key: "?", combo: "?" },
    ],
  },
  {
    action: "recent",
    label: "最近表示したドキュメント",
    bindings: [
      { kind: "ctrl", key: "r", combo: "Ctrl + R" },
      { kind: "seq", key: "r", combo: "G → R" },
    ],
  },
  {
    action: "home",
    label: "ホームへ移動",
    bindings: [
      { kind: "ctrl", key: "h", combo: "Ctrl + H" },
      { kind: "seq", key: "h", combo: "G → H" },
    ],
  },
  {
    action: "docs",
    label: "ドキュメント一覧へ移動",
    bindings: [{ kind: "seq", key: "d", combo: "G → D" }],
  },
  {
    action: "tags",
    label: "タグ一覧へ移動",
    bindings: [
      { kind: "ctrl", key: "t", combo: "Ctrl + T" },
      { kind: "seq", key: "t", combo: "G → T" },
    ],
  },
  {
    action: "graph",
    label: "グラフへ移動",
    bindings: [{ kind: "seq", key: "g", combo: "G → G" }],
  },
  {
    action: "stats",
    label: "統計へ移動",
    bindings: [{ kind: "seq", key: "s", combo: "G → S" }],
  },
  {
    action: "bucket",
    label: "Bucket 選択へフォーカス",
    bindings: [{ kind: "seq", key: "b", combo: "G → B" }],
  },
];

/**
 * Screen-scoped keys, listed here so the shortcut modal stays a single source.
 * The list screens are handled by usePageListNavigation (hooks.ts), the
 * document keys inside DocDetail.
 */
export const LIST_SHORTCUTS: Array<{ combo: string; label: string }> = [
  { combo: "J / K", label: "リストの選択を移動" },
  { combo: "Enter / O", label: "選択中のドキュメントを開く" },
  { combo: "H / L", label: "前のページ / 次のページ" },
];

export const DOC_SHORTCUTS: Array<{ combo: string; label: string }> = [
  { combo: "E", label: "本文の編集を開始" },
  { combo: "S", label: "お気に入りに追加 / 外す" },
  { combo: "U", label: "ドキュメント一覧へ戻る" },
  { combo: "#", label: "ドキュメントを削除" },
];

/** A second sequence key must follow the G prefix within this window */
export const SEQ_TIMEOUT_MS = 1000;

/** Typing in a field must never trigger a navigation shortcut */
export function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

/** An IME composition keystroke must never act as a shortcut */
export function isImeKey(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}

/**
 * True when a bare single-key shortcut may act on this keystroke. The
 * defaultPrevented check is load-bearing coordination between the window
 * listeners: useShortcuts (mounted in ModalProvider, above every page) runs
 * first and claims G-sequence keys via preventDefault, so `g s` never also
 * fires a page's own `s`.
 */
export function isBareKey(e: KeyboardEvent): boolean {
  return (
    !isImeKey(e) &&
    !e.defaultPrevented &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !isEditing(e.target)
  );
}

/**
 * Window-level keydown listener registered once (while enabled); the handler
 * is read through a ref, so it always sees the latest render's closures.
 */
export function useWindowKeydown(handler: (e: KeyboardEvent) => void, enabled = true): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => latest.current(e);
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled]);
}

/** The subset of KeyboardEvent the matcher reads — structural, so tests need no DOM */
export interface KeyStroke {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type ShortcutMatch =
  | { type: "action"; action: ShortcutAction }
  | { type: "prefix" }
  | { type: "none" };

const NONE: ShortcutMatch = { type: "none" };

function find(pick: (b: KeyBinding) => boolean): ShortcutMatch {
  for (const s of SHORTCUTS) {
    if (s.bindings.some(pick)) return { type: "action", action: s.action };
  }
  return NONE;
}

/**
 * Feed one keystroke into the matcher. `pending` is true when a G prefix is
 * still open; an unmatched second key falls through and is read as a fresh
 * keystroke, so `g` then `/` still opens search.
 */
export function resolveShortcut(e: KeyStroke, pending: boolean): ShortcutMatch {
  if (e.metaKey || e.altKey) return NONE;
  if (e.ctrlKey) {
    const key = e.key.toLowerCase();
    return find((b) => b.kind === "ctrl" && (b.shift ?? false) === e.shiftKey && b.key === key);
  }
  if (pending) {
    const hit = find((b) => b.kind === "seq" && b.key === e.key);
    if (hit.type === "action") return hit;
  }
  if (e.key === "g") return { type: "prefix" };
  return find((b) => b.kind === "bare" && b.key === e.key);
}

export function useShortcuts(run: (action: ShortcutAction) => void): void {
  // The G prefix is a deadline, not a timer — nothing to clean up
  const pendingUntil = useRef(0);
  useWindowKeydown((e) => {
    if (isImeKey(e)) return;
    if (isEditing(e.target)) return;
    const pending = Date.now() < pendingUntil.current;
    pendingUntil.current = 0;
    const hit = resolveShortcut(e, pending);
    if (hit.type === "prefix") {
      pendingUntil.current = Date.now() + SEQ_TIMEOUT_MS;
      return;
    }
    if (hit.type === "action") {
      e.preventDefault();
      run(hit.action);
    }
  });
}
