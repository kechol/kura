import { useLocation } from "wouter-preact";
import { type DocMeta, fetchRecentDocs } from "../api";
import { useBucket } from "../bucket";
import { formatDateTime } from "../format";
import { useAsync, useListNavigation } from "../hooks";
import { DocTitle, docHref } from "./DocLink";
import { Modal, ModalHints } from "./Modal";

const LIMIT = 20;

/** Ctrl+R — jump back into something recently read, without leaving the current screen */
export function RecentModal({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const { bucket } = useBucket();
  const recent = useAsync(() => fetchRecentDocs(bucket, { limit: LIMIT }), [bucket]);
  const docs = recent.data ?? [];

  const open = (d: DocMeta) => {
    navigate(docHref(d.key));
    onClose();
  };
  // No text field here, so the arrow keys are read from the window
  const nav = useListNavigation(docs, open, { global: true });

  return (
    <Modal label="最近表示したドキュメント" onClose={onClose}>
      <div class="modal-head">
        <h2>最近表示したドキュメント</h2>
        <span class="search-modal-bucket">{bucket}</span>
      </div>
      <div class="modal-results">
        {recent.error && <p class="error">{recent.error}</p>}
        {recent.loading && <p class="empty">読み込み中…</p>}
        {!recent.loading && docs.length === 0 && <p class="empty">履歴がありません</p>}
        <ul class="result-list">
          {docs.map((d, i) => (
            <li key={d.key}>
              <button
                type="button"
                class={`result-row${i === nav.index ? " active" : ""}`}
                onMouseEnter={() => nav.setIndex(i)}
                onClick={() => open(d)}
              >
                <span class="result-title">
                  <DocTitle doc={d} />
                </span>
                <span class="count">{formatDateTime(d.last_accessed_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <ModalHints
        hints={[
          ["↑↓ / J K", "移動"],
          ["Enter", "開く"],
          ["Esc", "閉じる"],
        ]}
      />
    </Modal>
  );
}
