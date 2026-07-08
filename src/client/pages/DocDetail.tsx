import { useMemo } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { deleteDoc, fetchDoc, fetchRelated, type RelatedDoc } from "../api";
import { DocContent } from "../components/DocContent";
import { formatDateTime } from "../format";
import { useAsync } from "../hooks";

function RelatedList({ docs }: { docs: RelatedDoc[] }) {
  if (docs.length === 0) return <p class="empty">なし</p>;
  return (
    <ul class="related-list">
      {docs.map((d) => (
        <li key={d.key}>
          <Link href={`/docs/${encodeURIComponent(d.key)}`}>{d.title}</Link>
          <span class="count">{d.bucket}</span>
        </li>
      ))}
    </ul>
  );
}

export function DocDetail({ docKey }: { docKey: string }) {
  const [, navigate] = useLocation();
  const doc = useAsync(() => fetchDoc(docKey), [docKey]);
  const related = useAsync(() => fetchRelated(docKey), [docKey]);

  // [[リンク]] のタイトル → key 解決マップ（outlinks の解決結果を利用）
  const resolve = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of related.data?.outlinks ?? []) {
      if (o.target) map.set(o.target_title.toLowerCase(), o.target.key);
    }
    return (title: string) => map.get(title.toLowerCase()) ?? null;
  }, [related.data]);

  if (doc.loading || related.loading) return <p class="empty">読み込み中…</p>;
  if (doc.error) return <p class="error">{doc.error}</p>;
  const d = doc.data;
  if (!d) return null;

  const remove = async () => {
    if (!confirm(`「${d.title}」を削除しますか？この操作は取り消せません。`)) return;
    try {
      await deleteDoc(d.key);
      navigate("/docs");
    } catch (e) {
      alert(`削除に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div class="doc-detail">
      <article class="doc-main">
        <div class="doc-header">
          <h1>{d.title}</h1>
          <div class="doc-actions">
            <Link href={`/docs/${encodeURIComponent(d.key)}/edit`} class="btn">
              編集
            </Link>
            <button type="button" class="btn btn-danger" onClick={remove}>
              削除
            </button>
          </div>
        </div>
        <DocContent content={d.content} contentType={d.content_type} resolve={resolve} />
      </article>
      <aside class="doc-side">
        <section class="side-box">
          <h2>メタ情報</h2>
          <dl class="meta-list">
            <div>
              <dt>Bucket</dt>
              <dd>
                <Link href={`/docs?bucket=${encodeURIComponent(d.bucket)}`}>{d.bucket}</Link>
              </dd>
            </div>
            <div>
              <dt>参照数</dt>
              <dd>{d.access_count}</dd>
            </div>
            <div>
              <dt>作成</dt>
              <dd>{formatDateTime(d.created_at)}</dd>
            </div>
            <div>
              <dt>更新</dt>
              <dd>{formatDateTime(d.updated_at)}</dd>
            </div>
            {d.source_url && (
              <div>
                <dt>ソース</dt>
                <dd>
                  <a href={d.source_url} target="_blank" rel="noreferrer">
                    {d.source_url}
                  </a>
                </dd>
              </div>
            )}
          </dl>
        </section>
        <section class="side-box">
          <h2>タグ</h2>
          {d.tags.length === 0 ? (
            <p class="empty">なし</p>
          ) : (
            <div class="tag-cell">
              {d.tags.map((t) => (
                <Link key={t} class="tag-chip" href={`/docs?tag=${encodeURIComponent(t)}`}>
                  #{t}
                </Link>
              ))}
            </div>
          )}
        </section>
        <section class="side-box">
          <h2>バックリンク</h2>
          {related.error ? (
            <p class="error">{related.error}</p>
          ) : (
            <RelatedList docs={related.data?.backlinks ?? []} />
          )}
        </section>
        <section class="side-box">
          <h2>2ホップリンク</h2>
          {(related.data?.twoHop ?? []).length === 0 ? (
            <p class="empty">なし</p>
          ) : (
            (related.data?.twoHop ?? []).map((g) => (
              <div class="twohop-group" key={g.via.key}>
                <h3>
                  <Link href={`/docs/${encodeURIComponent(g.via.key)}`}>{g.via.title}</Link> 経由
                </h3>
                <RelatedList docs={g.docs} />
              </div>
            ))
          )}
        </section>
      </aside>
    </div>
  );
}
