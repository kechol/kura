import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useCallback, useContext, useMemo, useState } from "preact/hooks";
import type { DocDetail } from "./api";

interface CurrentDoc {
  doc: DocDetail | null;
  /** Published by the detail screen; the sidebar reads it. null on every other screen. */
  publish: (doc: DocDetail | null, reload: () => void) => void;
  reload: () => void;
}

const Context = createContext<CurrentDoc>({ doc: null, publish: () => {}, reload: () => {} });

/**
 * The document currently on screen. The sidebar shows its tags and neighbours, and lives in
 * Layout — so the detail screen publishes what it already fetched instead of the sidebar
 * fetching it a second time.
 */
export function CurrentDocProvider({ children }: { children: ComponentChildren }) {
  const [state, setState] = useState<{ doc: DocDetail | null; reload: () => void }>({
    doc: null,
    reload: () => {},
  });

  const publish = useCallback((doc: DocDetail | null, reload: () => void) => {
    setState((prev) => (prev.doc === doc ? prev : { doc, reload }));
  }, []);

  const value = useMemo<CurrentDoc>(
    () => ({ doc: state.doc, publish, reload: state.reload }),
    [state, publish],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCurrentDoc(): CurrentDoc {
  return useContext(Context);
}
