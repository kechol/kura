import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useCallback, useContext, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { createDoc } from "./api";
import { useBucket } from "./bucket";
import { docHref } from "./components/DocLink";
import { RecentModal } from "./components/RecentModal";
import { SearchModal } from "./components/SearchModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { type ShortcutAction, useShortcuts } from "./shortcuts";

type ModalKind = "search" | "shortcuts" | "recent";

/** A new document is born untitled at the bucket root; the title is editable in place */
const UNTITLED = "無題";

interface ModalState {
  open: (kind: ModalKind) => void;
  close: () => void;
  /** Create an untitled document in the selected bucket and open it (Ctrl+N) */
  createUntitled: () => void;
}

const ModalContext = createContext<ModalState>({
  open: () => {},
  close: () => {},
  createUntitled: () => {},
});

/**
 * Owns the modals and the global shortcut handler. Navigation shortcuts route directly;
 * the rest open a modal. Rendered inside the router so it can navigate.
 */
export function ModalProvider({ children }: { children: ComponentChildren }) {
  const [, navigate] = useLocation();
  const { bucket } = useBucket();
  const [kind, setKind] = useState<ModalKind | null>(null);

  const open = useCallback((next: ModalKind) => setKind(next), []);
  const close = useCallback(() => setKind(null), []);

  const createUntitled = useCallback(() => {
    if (bucket === "") return;
    setKind(null);
    createDoc({ title: UNTITLED, bucket, content: "" }).then(
      (doc) => navigate(docHref(doc.key)),
      (e: unknown) => alert(`作成に失敗しました: ${e instanceof Error ? e.message : String(e)}`),
    );
  }, [bucket, navigate]);

  const run = useCallback(
    (action: ShortcutAction) => {
      switch (action) {
        case "home":
          setKind(null);
          navigate("/");
          return;
        case "tags":
          setKind(null);
          navigate("/tags");
          return;
        case "new":
          createUntitled();
          return;
        default:
          setKind(action);
      }
    },
    [navigate, createUntitled],
  );
  useShortcuts(run);

  return (
    <ModalContext.Provider value={{ open, close, createUntitled }}>
      {children}
      {kind === "search" && <SearchModal onClose={close} />}
      {kind === "recent" && <RecentModal onClose={close} />}
      {kind === "shortcuts" && <ShortcutsModal onClose={close} />}
    </ModalContext.Provider>
  );
}

export function useModal(): ModalState {
  return useContext(ModalContext);
}
