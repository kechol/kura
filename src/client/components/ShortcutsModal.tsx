import { DOC_SHORTCUTS, LIST_SHORTCUTS, SHORTCUTS } from "../shortcuts";
import { Modal, ModalHints } from "./Modal";

function Row({ combos, label }: { combos: string[]; label: string }) {
  return (
    <div>
      <dt>
        {combos.map((c) => (
          <kbd key={c}>{c}</kbd>
        ))}
      </dt>
      <dd>{label}</dd>
    </div>
  );
}

/** Ctrl+? / ? — the shortcut list, generated from the same tables the handlers use */
export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal label="ショートカット" onClose={onClose}>
      <div class="modal-head">
        <h2>ショートカット</h2>
      </div>
      <div class="modal-results">
        <dl class="shortcut-list">
          {SHORTCUTS.map((s) => (
            <Row key={s.action} combos={s.bindings.map((b) => b.combo)} label={s.label} />
          ))}
        </dl>
        <h3 class="shortcut-group">一覧画面（ドキュメント一覧・検索・ホーム）</h3>
        <dl class="shortcut-list">
          {LIST_SHORTCUTS.map((s) => (
            <Row key={s.combo} combos={[s.combo]} label={s.label} />
          ))}
        </dl>
        <h3 class="shortcut-group">ドキュメント画面</h3>
        <dl class="shortcut-list">
          {DOC_SHORTCUTS.map((s) => (
            <Row key={s.combo} combos={[s.combo]} label={s.label} />
          ))}
          <Row combos={["Esc"]} label="編集を終了 / モーダルを閉じる" />
        </dl>
        <p class="muted">
          入力欄にカーソルがあるときは、Esc 以外のショートカットは動作しません。G で始まる操作は、G
          のあと 1 秒以内に次のキーを押します。macOS 以外では、ブラウザが Ctrl + T
          などを先に受け取ることがあります。
        </p>
      </div>
      <ModalHints hints={[["Esc", "閉じる"]]} />
    </Modal>
  );
}
