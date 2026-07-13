import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useCallback, useContext, useMemo, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { type Bucket, fetchBuckets } from "./api";
import { useAsync } from "./hooks";

const STORAGE_KEY = "kura-bucket";

export interface BucketState {
  /** The bucket every screen is scoped to; "" only while the list is still loading */
  bucket: string;
  buckets: Bucket[];
  setBucket: (name: string) => void;
  loading: boolean;
}

const BucketContext = createContext<BucketState>({
  bucket: "",
  buckets: [],
  setBucket: () => {},
  loading: true,
});

function storedBucket(): string {
  return localStorage.getItem(STORAGE_KEY) ?? "";
}

/**
 * Selected-bucket state, shared by every screen. This is the one piece of UI state
 * kept outside the URL (docs: browser-ui.md) because it scopes the whole app: browsing,
 * search, the sidebar trees and the graph never cross bucket boundaries.
 */
export function BucketProvider({ children }: { children: ComponentChildren }) {
  const [location] = useLocation();
  // Refetch on navigation to keep the document counts current (cheap against the local API)
  const buckets = useAsync(fetchBuckets, [location]);
  const [selected, setSelected] = useState(storedBucket);

  const names = (buckets.data ?? []).map((b) => b.name);
  // Before the list arrives, trust the stored name so a reload does not flash another bucket
  const bucket =
    names.length === 0
      ? selected
      : names.includes(selected)
        ? selected
        : names.includes("main")
          ? "main"
          : (names[0] ?? "");

  const setBucket = useCallback((name: string) => {
    localStorage.setItem(STORAGE_KEY, name);
    setSelected(name);
  }, []);

  // Memoized so a navigation that changes nothing does not re-render every consumer
  const value = useMemo<BucketState>(
    () => ({
      bucket,
      buckets: buckets.data ?? [],
      setBucket,
      loading: buckets.loading,
    }),
    [bucket, buckets.data, buckets.loading, setBucket],
  );
  return <BucketContext.Provider value={value}>{children}</BucketContext.Provider>;
}

export function useBucket(): BucketState {
  return useContext(BucketContext);
}
