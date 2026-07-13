import { useCallback, useEffect, useRef, useState } from "preact/hooks";

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

  useEffect(() => setIndex(0), [items]);

  const onKeyDown = (e: KeyboardEvent) => {
    // Enter during an IME composition confirms the conversion — it must not pick a result
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const item = items[index];
      if (item !== undefined) {
        e.preventDefault();
        onSelect(item);
      }
    }
  };

  const latest = useRef(onKeyDown);
  latest.current = onKeyDown;
  const { global = false } = opts;
  useEffect(() => {
    if (!global) return;
    const handler = (e: KeyboardEvent) => latest.current(e);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [global]);

  return { index, setIndex, onKeyDown };
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
