import { Link, useLocation } from "wouter-preact";
import { fetchRecentDocs } from "../api";
import { useBucket } from "../bucket";
import { DocLinkList, docHref } from "../components/DocLink";
import { formatDateTime } from "../format";
import { useAsync, useDocumentTitle, usePageListNavigation } from "../hooks";
import { useModal } from "../modal";

const RECENT = 50;

/** Home = the reading history. Statistics moved to /stats. */
export function Home() {
  useDocumentTitle(null);
  const [, navigate] = useLocation();
  const { bucket } = useBucket();
  const modal = useModal();
  const recent = useAsync(() => fetchRecentDocs(bucket, { limit: RECENT }), [bucket]);
  const docs = recent.data ?? [];
  const cursor = usePageListNavigation(recent.data, (d) => navigate(docHref(d.key)), {
    disabled: modal.isOpen,
  });

  return (
    <div class="page">
      <h1>最近表示したドキュメント</h1>
      {recent.error && <p class="error">{recent.error}</p>}
      {recent.loading && <p class="empty">読み込み中…</p>}
      {!recent.loading && docs.length === 0 ? (
        <p class="empty">
          まだ表示履歴がありません。<Link href="/docs">ドキュメント一覧</Link>
          から開いてみてください。
        </p>
      ) : (
        <DocLinkList
          docs={docs}
          class="recent-list"
          cursor={cursor}
          meta={(d) => `${formatDateTime(d.last_accessed_at)} · 参照 ${d.access_count} 回`}
        />
      )}
    </div>
  );
}
