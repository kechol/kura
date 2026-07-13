import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { ApiError, deleteDoc, fetchDoc, fetchRelated, type RelatedDoc, updateDoc } from "../api";
import { useBucket } from "../bucket";
import { DocContent } from "../components/DocContent";
import { DocLinkList } from "../components/DocLink";
import { useCurrentDoc } from "../currentdoc";
import { Editor, type SaveStatus } from "../editor/Editor";
import { formatDateTime } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { forgetDoc, rememberDoc } from "../lastdoc";

/** Titles created by Ctrl+N: "無題", and "無題 (2)" when that one is taken */
const UNTITLED_RE = /^無題(?: \(\d+\))?$/;

const SAVE_LABEL: Record<SaveStatus, string> = {
  idle: "",
  dirty: "未保存",
  saving: "保存中…",
  saved: "保存しました",
  error: "保存に失敗しました",
};

function RelatedList({ docs }: { docs: RelatedDoc[] }) {
  return <DocLinkList docs={docs} class="related-list" />;
}

export function DocDetail({ docKey }: { docKey: string }) {
  const [, navigate] = useLocation();
  const { bucket, setBucket } = useBucket();
  const doc = useAsync(async () => {
    try {
      const fetched = await fetchDoc(docKey);
      rememberDoc(docKey);
      return fetched;
    } catch (e) {
      // A deleted document must not keep hijacking the boot redirect
      if (e instanceof ApiError && e.status === 404) forgetDoc(docKey);
      throw e;
    }
  }, [docKey]);
  const related = useAsync(() => fetchRelated(docKey), [docKey]);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const d = doc.data;

  useDocumentTitle(d?.title ?? null);

  // A document reached from another bucket (direct URL, wiki link) pulls the selection with it,
  // so the sidebar and every search stay scoped to what is on screen
  const docBucket = d?.bucket;
  useEffect(() => {
    if (docBucket !== undefined && docBucket !== bucket) setBucket(docBucket);
  }, [docBucket, bucket, setBucket]);

  // Hand the fetched document to the sidebar (tags, same-tag and same-path neighbours)
  const { publish } = useCurrentDoc();
  const reload = doc.reload;
  useEffect(() => {
    publish(d ?? null, reload);
    return () => publish(null, reload);
  }, [d, publish, reload]);

  // [[link]] title → key resolution map (reuses the resolved outlinks)
  const resolve = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of related.data?.outlinks ?? []) {
      if (o.target) map.set(o.target_title.toLowerCase(), o.target.key);
    }
    return (title: string) => map.get(title.toLowerCase()) ?? null;
  }, [related.data]);

  // A just-created document (Ctrl+N) opens with its placeholder title selected, so the first
  // thing typed replaces it instead of landing in an empty body. The condition includes the
  // loading flags on purpose: the title only exists once both queries are in, and the effect
  // must not spend its one dependency change on a render that has no <h1> yet.
  const titleRef = useRef<HTMLHeadingElement>(null);
  const untitled =
    !doc.loading && !related.loading && d !== null && d.content === "" && UNTITLED_RE.test(d.title);
  useEffect(() => {
    const el = titleRef.current;
    if (!untitled || !el) return;
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, [untitled]);

  if (doc.loading || related.loading) return <p class="empty">読み込み中…</p>;
  if (doc.error) return <p class="error">{doc.error}</p>;
  if (!d) return null;

  const markdown = d.content_type !== "html";

  const renameTo = async (title: string) => {
    const next = title.trim();
    if (next === "" || next === d.title) return;
    setStatus("saving");
    try {
      await updateDoc(d.key, { title: next });
      setStatus("saved");
      doc.reload();
    } catch {
      setStatus("error");
    }
  };

  const remove = async () => {
    if (!confirm(`「${d.title}」を削除しますか？この操作は取り消せません。`)) return;
    try {
      await deleteDoc(d.key);
      forgetDoc(d.key);
      navigate("/docs");
    } catch (e) {
      alert(`削除に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  return (
    <div class="doc-detail">
      <article class="doc-main">
        {d.path !== "" && (
          <nav class="doc-breadcrumb" aria-label="ドキュメントパス">
            {d.path.split("/").map((seg, i, segs) => {
              const prefix = segs.slice(0, i + 1).join("/");
              return (
                <span key={prefix}>
                  {i > 0 && <span class="doc-breadcrumb-sep">/</span>}
                  <Link href={`/docs?prefix=${encodeURIComponent(prefix)}`}>{seg}</Link>
                </span>
              );
            })}
          </nav>
        )}
        <div class="doc-header">
          <h1
            class="doc-title"
            ref={titleRef}
            contentEditable={markdown}
            onBlur={(e) => void renameTo((e.currentTarget as HTMLElement).textContent ?? "")}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                (e.currentTarget as HTMLElement).blur();
              }
            }}
          >
            {d.title}
          </h1>
          <div class="doc-actions">
            <span class={`save-status ${status}`}>{SAVE_LABEL[status]}</span>
            <button type="button" class="btn btn-danger" onClick={remove}>
              削除
            </button>
          </div>
        </div>
        {markdown ? (
          <Editor
            key={d.key}
            initial={d.content}
            resolve={resolve}
            onStatus={setStatus}
            onSave={(content) => updateDoc(d.key, { content }).then(() => undefined)}
          />
        ) : (
          // Clipped HTML documents stay read-only: their markup is not ours to restructure
          <DocContent content={d.content} contentType={d.content_type} resolve={resolve} />
        )}
      </article>
      <aside class="doc-side">
        <section class="side-box">
          <h2>メタ情報</h2>
          <dl class="meta-list">
            <div>
              <dt>Bucket</dt>
              <dd>{d.bucket}</dd>
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
