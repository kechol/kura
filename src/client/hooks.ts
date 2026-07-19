import { useCallback, useEffect, useState } from "preact/hooks";
import { isBareKey, isImeKey, useWindowKeydown } from "./shortcuts";

export interface AsyncState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Generic fetch hook that re-runs fn whenever deps change */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // deps = caller-provided array + tick for reload
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fn().then(
      (d) => {
        if (!alive) return;
        setData(d);
        setLoading(false);
      },
      (e: unknown) => {
        if (!alive) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/** Set document.title for the current screen; pass null while the name is still loading */
export function useDocumentTitle(title: string | null): void {
  useEffect(() => {
    document.title = title === null || title === "" ? "kura" : `${title} — kura`;
  }, [title]);
}

export interface ListNavigation {
  index: number;
  setIndex: (i: number) => void;
  /** Attach to the input that owns the list (↑ ↓ move, Enter selects) */
  onKeyDown: (e: KeyboardEvent) => void;
}

/**
 * Arrow-key navigation over a result list, shared by the modals. With `global`, the
 * keys are read from the window instead of an input — for lists that have no text field
 * of their own, which keeps the list a plain <ul> of buttons rather than a fake listbox.
 */
export function useListNavigation<T>(
  items: T[],
  onSelect: (item: T) => void,
  opts: { global?: boolean } = {},
): ListNavigation {
  const [index, setIndex] = useState(0);
  const { global = false } = opts;

  useEffect(() => setIndex(0), [items]);

  const onKeyDown = (e: KeyboardEvent) => {
    // Enter during an IME composition confirms the conversion — it must not pick a result
    if (isImeKey(e)) return;
    // In global mode no input owns the list, so J/K alias the arrows — the same cursor
    // keys as the page lists (usePageListNavigation)
    const vim = global && isBareKey(e);
    if (e.key === "ArrowDown" || (vim && e.key === "j")) {
      e.preventDefault();
      setIndex((i) => stepIndex(i, true, items.length));
    } else if (e.key === "ArrowUp" || (vim && e.key === "k")) {
      e.preventDefault();
      setIndex((i) => stepIndex(i, false, items.length));
    } else if (e.key === "Enter") {
      const item = items[index];
      if (item !== undefined) {
        e.preventDefault();
        onSelect(item);
      }
    }
  };

  useWindowKeydown(onKeyDown, global);

  return { index, setIndex, onKeyDown };
}

/** One cursor step, clamped to the list */
const stepIndex = (i: number, down: boolean, length: number): number =>
  down ? Math.min(i + 1, length - 1) : Math.max(i - 1, 0);

/**
 * Gmail/GitHub-style keyboard cursor over the main list of a screen: J/K move,
 * Enter or O opens the selected row, and — when the screen pages — H/L turn pages.
 * Window-level like useShortcuts, with the same IME and focused-field guards;
 * `disabled` stands the handler down while a modal is open. Takes the fetched
 * list as-is (null/undefined while loading — identity matters, a fresh `?? []`
 * per render would reset the cursor). Returns the cursor index, -1 = no row
 * selected. The cursor row must render class "kbd-cursor" (that is also what
 * the scroll follow-up targets).
 */
export function usePageListNavigation<T>(
  items: T[] | null | undefined,
  onOpen: (item: T) => void,
  opts: { disabled?: boolean; onPage?: (delta: 1 | -1) => void } = {},
): number {
  const [index, setIndex] = useState(-1);
  useEffect(() => setIndex(-1), [items]);

  // Keep the cursor row visible as it moves
  useEffect(() => {
    if (index >= 0) document.querySelector(".kbd-cursor")?.scrollIntoView({ block: "nearest" });
  }, [index]);

  useWindowKeydown((e) => {
    if (opts.disabled === true || !isBareKey(e)) return;
    const list = items ?? [];
    if (e.key === "j" || e.key === "k") {
      if (list.length === 0) return;
      e.preventDefault();
      setIndex((i) => stepIndex(i, e.key === "j", list.length));
    } else if (e.key === "Enter" || e.key === "o") {
      const item = list[index];
      if (index < 0 || item === undefined) return;
      // Enter on a focused link or button stays native; O has no native action
      if (
        e.key === "Enter" &&
        e.target instanceof HTMLElement &&
        e.target.closest("a, button") !== null
      )
        return;
      e.preventDefault();
      onOpen(item);
    } else if ((e.key === "h" || e.key === "l") && opts.onPage !== undefined) {
      e.preventDefault();
      opts.onPage(e.key === "l" ? 1 : -1);
    }
  });
  return index;
}

/** Debounce a fast-changing value (search input → API call) */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
