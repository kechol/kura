import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * Modal shell: overlay, Escape to close, focus moved in on open and restored on close.
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
    panel.current?.querySelector<HTMLElement>("input, button, [tabindex]")?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        onClose();
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
      {/* A real button, so dismissing by clicking outside is reachable without a mouse too */}
      <button type="button" class="modal-backdrop" aria-label="閉じる" onClick={onClose} />
      <div class="modal" role="dialog" aria-modal="true" aria-label={label} ref={panel}>
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
