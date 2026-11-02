import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useContext, useMemo, useState } from "preact/hooks";
import type { DocDetail } from "./api";

interface CurrentDoc {
  doc: DocDetail | null;
  /** Published by the detail screen; the sidebar reads it. null on every other screen. */
  publish: (doc: DocDetail | null) => void;
}

const Context = createContext<CurrentDoc>({ doc: null, publish: () => {} });

/**
 * The document currently on screen. The sidebar shows its neighbours, and lives in Layout — so
 * the detail screen publishes what it already fetched instead of the sidebar fetching it a
 * second time.
 */
export function CurrentDocProvider({ children }: { children: ComponentChildren }) {
  const [doc, publish] = useState<DocDetail | null>(null);
  const value = useMemo<CurrentDoc>(() => ({ doc, publish }), [doc]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useCurrentDoc(): CurrentDoc {
  return useContext(Context);
}
