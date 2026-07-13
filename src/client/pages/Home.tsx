import { Link } from "wouter-preact";
import { fetchRecentDocs } from "../api";
import { useBucket } from "../bucket";
import { DocLinkList } from "../components/DocLink";
import { formatDateTime } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";

const RECENT = 50;

/** Home = the reading history. Statistics moved to /stats. */
export function Home() {
  useDocumentTitle(null);
  const { bucket } = useBucket();
  const recent = useAsync(() => fetchRecentDocs(bucket, { limit: RECENT }), [bucket]);

  return (
    <div class="page">
      <h1>最近表示したドキュメント</h1>
      {recent.error && <p class="error">{recent.error}</p>}
      {recent.loading && <p class="empty">読み込み中…</p>}
      {!recent.loading && (recent.data ?? []).length === 0 ? (
        <p class="empty">
          まだ表示履歴がありません。<Link href="/docs">ドキュメント一覧</Link>
          から開いてみてください。
        </p>
      ) : (
        <DocLinkList
          docs={recent.data ?? []}
          class="recent-list"
          meta={(d) => `${formatDateTime(d.last_accessed_at)} · 参照 ${d.access_count} 回`}
        />
      )}
    </div>
  );
}
