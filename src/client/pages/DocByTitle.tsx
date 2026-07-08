import { useEffect } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { searchDocs } from "../api";
import { useAsync } from "../hooks";

/** [[リンク]] のタイトル → key 解決ルート。完全一致があれば詳細へリダイレクトする */
export function DocByTitle({ title }: { title: string }) {
  const [, navigate] = useLocation();
  const state = useAsync(async () => {
    const res = await searchDocs({ q: title, mode: "keyword", limit: 50 });
    const exact = res.hits.find((h) => h.title.toLowerCase() === title.toLowerCase()) ?? null;
    return { exact, hits: res.hits };
  }, [title]);

  useEffect(() => {
    if (state.data?.exact) {
      navigate(`/docs/${encodeURIComponent(state.data.exact.key)}`, { replace: true });
    }
  }, [state.data, navigate]);

  if (state.loading) return <p class="empty">解決中…</p>;

  return (
    <div class="page">
      <h1>未解決リンク</h1>
      <p>
        「<strong>{title}</strong>」というドキュメントはまだ存在しません。
      </p>
      {state.error && <p class="error">{state.error}</p>}
      {state.data && state.data.hits.length > 0 && (
        <section>
          <h2>近いドキュメント</h2>
          <ul class="doc-links">
            {state.data.hits.slice(0, 10).map((h) => (
              <li key={h.key}>
                <Link href={`/docs/${encodeURIComponent(h.key)}`}>{h.title}</Link>
                <span class="doc-link-meta">{h.bucket}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
