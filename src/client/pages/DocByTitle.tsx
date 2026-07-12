import { useEffect } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { ApiError, resolveDocSpec, searchDocs } from "../api";
import { useAsync } from "../hooks";

/**
 * [[link]] title → key resolution route. Tries GET /api/resolve first
 * (full path / unique title, same rules as the CLI), then falls back to a
 * keyword search for suggestions.
 */
export function DocByTitle({ title }: { title: string }) {
  const [, navigate] = useLocation();
  const state = useAsync(async () => {
    try {
      const doc = await resolveDocSpec(title);
      return { exact: doc, hits: [] };
    } catch (e) {
      // 404: not created yet; 409: ambiguous — both fall back to suggestions
      if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 409)) throw e;
    }
    const res = await searchDocs({ q: title, mode: "keyword", limit: 50 });
    return { exact: null, hits: res.hits };
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
                <Link href={`/docs/${encodeURIComponent(h.key)}`}>
                  {h.path === "" ? h.title : `${h.path}/${h.title}`}
                </Link>
                <span class="doc-link-meta">{h.bucket}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
