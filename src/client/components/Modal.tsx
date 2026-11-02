import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

const FOCUSABLE = 'a[href], button:not([disabled]), input, select, textarea, [tabindex="0"]';

/**
 * Modal shell: overlay, Escape to close, Tab kept inside, focus moved in on open and
 * restored on close. The panel takes focus itself while its content is still loading.
 * The Raycast-style panel floats near the top of the viewport rather than centered,
 * so a growing result list does not shift the input under the cursor.
 */
export function Modal({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusables = () => [...(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    (focusables()[0] ?? panel.current)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        onClose();
      } else if (e.key === "Tab") {
        const items = focusables();
        const first = items[0] ?? panel.current;
        const last = items[items.length - 1] ?? panel.current;
        const active = document.activeElement;
        const outside = !panel.current?.contains(active);
        if (e.shiftKey && (outside || active === first || active === panel.current)) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && (outside || active === last)) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [onClose]);

  return (
    <div class="modal-overlay">
      {/* Pointer-only dismissal: the keyboard closes with Escape, so Tab never lands here */}
      <button
        type="button"
        class="modal-backdrop"
        aria-label="閉じる"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        ref={panel}
      >
        {children}
      </div>
    </div>
  );
}

export function ModalHints({ hints }: { hints: Array<[string, string]> }) {
  return (
    <footer class="modal-hints">
      {hints.map(([key, label]) => (
        <span key={key}>
          <kbd>{key}</kbd> {label}
        </span>
      ))}
    </footer>
  );
}
