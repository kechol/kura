import { SHORTCUTS } from "../shortcuts";
import { Modal, ModalHints } from "./Modal";

/** Ctrl+? — the shortcut list, generated from the same table the handler uses */
export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="ショートカット" onClose={onClose}>
      <div class="modal-head">
        <h2>ショートカット</h2>
      </div>
      <div class="modal-results">
        <dl class="shortcut-list">
          {SHORTCUTS.map((s) => (
            <div key={s.action}>
              <dt>
                <kbd>{s.combo}</kbd>
              </dt>
              <dd>{s.label}</dd>
            </div>
          ))}
          <div>
            <dt>
              <kbd>Esc</kbd>
            </dt>
            <dd>モーダルを閉じる</dd>
          </div>
        </dl>
        <p class="muted">
          入力欄にカーソルがあるときは、Esc 以外のショートカットは動作しません。macOS
          以外では、ブラウザが Ctrl + T を先に受け取ることがあります。
        </p>
      </div>
      <ModalHints hints={[["Esc", "閉じる"]]} />
    </Modal>
  );
}
