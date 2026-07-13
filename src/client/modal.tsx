import type { ComponentChildren } from "preact";
import { createContext } from "preact";
import { useCallback, useContext, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { RecentModal } from "./components/RecentModal";
import { SearchModal } from "./components/SearchModal";
import { ShortcutsModal } from "./components/ShortcutsModal";
import { type ShortcutAction, useShortcuts } from "./shortcuts";

type ModalKind = "search" | "shortcuts" | "recent";

interface ModalState {
  open: (kind: ModalKind) => void;
  close: () => void;
}

const ModalContext = createContext<ModalState>({ open: () => {}, close: () => {} });

/**
 * Owns the modals and the global shortcut handler. Navigation shortcuts route directly;
 * the rest open a modal. Rendered inside the router so it can navigate.
 */
export function ModalProvider({ children }: { children: ComponentChildren }) {
  const [, navigate] = useLocation();
  const [kind, setKind] = useState<ModalKind | null>(null);

  const open = useCallback((next: ModalKind) => setKind(next), []);
  const close = useCallback(() => setKind(null), []);

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
        default:
          setKind(action);
      }
    },
    [navigate],
  );
  useShortcuts(run);

  return (
    <ModalContext.Provider value={{ open, close }}>
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
