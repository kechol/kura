import { useEffect } from "preact/hooks";

/**
 * Global keyboard shortcuts.
 *
 * All of them use **Ctrl**, never Cmd: on macOS the browser and the OS reserve
 * Cmd+T (new tab), Cmd+H (hide app) and Cmd+R (reload), and a web page cannot
 * take them back. Ctrl+<letter> is effectively free there, and on Windows /
 * Linux the browser still owns Ctrl+T — documented as a known limitation
 * rather than worked around (docs: browser-ui.md).
 */

export type ShortcutAction = "search" | "shortcuts" | "recent" | "home" | "tags" | "new";

export interface Shortcut {
  action: ShortcutAction;
  /** event.key, compared case-insensitively */
  key: string;
  shift?: boolean;
  /** Rendered in the shortcut list */
  combo: string;
  label: string;
}

export const SHORTCUTS: Shortcut[] = [
  { action: "search", key: "p", combo: "Ctrl + P", label: "検索する" },
  { action: "new", key: "n", combo: "Ctrl + N", label: "新しいドキュメントを作成" },
  { action: "shortcuts", key: "/", shift: true, combo: "Ctrl + ?", label: "ショートカット一覧" },
  { action: "recent", key: "r", combo: "Ctrl + R", label: "最近表示したドキュメント" },
  { action: "home", key: "h", combo: "Ctrl + H", label: "ホームへ移動" },
  { action: "tags", key: "t", combo: "Ctrl + T", label: "タグ一覧へ移動" },
];

/** Typing in a field must never trigger a navigation shortcut */
function isEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function match(e: KeyboardEvent, s: Shortcut): boolean {
  if (!e.ctrlKey || e.metaKey || e.altKey) return false;
  if ((s.shift ?? false) !== e.shiftKey) return false;
  return e.key.toLowerCase() === s.key;
}

export function useShortcuts(run: (action: ShortcutAction) => void): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Never act on an IME composition keystroke
      if (e.isComposing || e.keyCode === 229) return;
      if (isEditing(e.target)) return;
      const hit = SHORTCUTS.find((s) => match(e, s));
      if (!hit) return;
      e.preventDefault();
      run(hit.action);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [run]);
}
