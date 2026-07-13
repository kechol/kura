import { useLocation } from "wouter-preact";
import { type DocMeta, fetchDocs } from "../api";
import { useBucket } from "../bucket";
import { formatDateTime } from "../format";
import { useAsync, useListNavigation } from "../hooks";
import { Modal, ModalHints } from "./Modal";

const LIMIT = 20;

/** Ctrl+R — jump back into something recently read, without leaving the current screen */
export function RecentModal({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const { bucket } = useBucket();
  const recent = useAsync(() => fetchDocs({ bucket, sort: "accessed", per: LIMIT }), [bucket]);
  const docs = (recent.data?.docs ?? []).filter((d) => d.last_accessed_at !== null);

  const open = (d: DocMeta) => {
    navigate(`/docs/${encodeURIComponent(d.key)}`);
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
                  {d.path !== "" && <span class="doc-path-prefix">{d.path}/</span>}
                  {d.title}
                </span>
                <span class="count">{formatDateTime(d.last_accessed_at)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <ModalHints
        hints={[
          ["↑↓", "移動"],
          ["Enter", "開く"],
          ["Esc", "閉じる"],
        ]}
      />
    </Modal>
  );
}
