import { Link } from "wouter-preact";
import { fetchDocs } from "../api";
import { useBucket } from "../bucket";
import { formatDateTime } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";

const RECENT = 50;

/** Home = the reading history. Statistics moved to /stats. */
export function Home() {
  useDocumentTitle(null);
  const { bucket } = useBucket();
  const recent = useAsync(() => fetchDocs({ bucket, sort: "accessed", per: RECENT }), [bucket]);
  const docs = (recent.data?.docs ?? []).filter((d) => d.last_accessed_at !== null);

  return (
    <div class="page">
      <h1>最近表示したドキュメント</h1>
      {recent.error && <p class="error">{recent.error}</p>}
      {recent.loading && <p class="empty">読み込み中…</p>}
      {!recent.loading && docs.length === 0 && (
        <p class="empty">
          まだ表示履歴がありません。<Link href="/docs">ドキュメント一覧</Link>
          から開いてみてください。
        </p>
      )}
      {docs.length > 0 && (
        <ul class="recent-list">
          {docs.map((d) => (
            <li key={d.key}>
              <Link href={`/docs/${encodeURIComponent(d.key)}`} class="recent-title">
                {d.path !== "" && <span class="doc-path-prefix">{d.path}/</span>}
                {d.title}
              </Link>
              <span class="recent-meta">
                {d.last_accessed_at === null ? "—" : formatDateTime(d.last_accessed_at)} · 参照{" "}
                {d.access_count} 回
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
