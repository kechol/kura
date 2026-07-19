import { Star, Trash2 } from "lucide-preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import {
  ApiError,
  type DocTreeNode,
  deleteDoc,
  fetchDoc,
  fetchDocTree,
  fetchRelated,
  type RelatedDoc,
  setFavorite,
  updateDoc,
} from "../api";
import { useBucket } from "../bucket";
import { DocContent } from "../components/DocContent";
import { DocLinkList } from "../components/DocLink";
import { InlineEditField } from "../components/InlineEditField";
import { useCurrentDoc } from "../currentdoc";
import { Editor, type SaveStatus } from "../editor/Editor";
import { formatDateTime } from "../format";
import { useAsync, useDocumentTitle } from "../hooks";
import { forgetDoc, rememberDoc } from "../lastdoc";
import { useModal } from "../modal";
import { isBareKey, useWindowKeydown } from "../shortcuts";

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

/** Every path already in use in the bucket, as completions for the path field */
function treePaths(nodes: DocTreeNode[], into: string[] = []): string[] {
  for (const n of nodes) {
    into.push(n.path);
    treePaths(n.children, into);
  }
  return into;
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
  const [pathError, setPathError] = useState<string | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);
  const tree = useAsync(
    () => (bucket === "" ? Promise.resolve([]) : fetchDocTree(bucket)),
    [bucket, docKey],
  );
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

  // Single-key document shortcuts (S / # / U / E — see DOC_SHORTCUTS). The actions are
  // read through a ref assigned during render, so the listener never closes over a stale
  // document; while a document is (re)loading the ref is null and the keys do nothing.
  const modalOpen = useModal().isOpen;
  const docKeys = useRef<Record<string, () => void> | null>(null);
  useWindowKeydown((e) => {
    if (modalOpen || !isBareKey(e)) return;
    const fn = docKeys.current?.[e.key];
    if (fn === undefined) return;
    e.preventDefault();
    fn();
  });

  docKeys.current = null;
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

  // '' is a legal path (the bucket root), so an empty field saves rather than cancelling
  const moveTo = async (raw: string) => {
    const next = raw.trim().replace(/^\/+|\/+$/g, "");
    setPathError(null);
    if (next === d.path) return;
    setStatus("saving");
    try {
      await updateDoc(d.key, { path: next });
      setStatus("saved");
      doc.reload();
    } catch (e) {
      setStatus("error");
      setPathError(e instanceof Error ? e.message : String(e));
    }
  };

  // The comma-separated field is the full alias set (the server diff-syncs it)
  const saveAliases = async (raw: string) => {
    const next = raw
      .split(/[,、]/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    setAliasError(null);
    if (next.join("\n") === d.aliases.join("\n")) return;
    setStatus("saving");
    try {
      await updateDoc(d.key, { aliases: next });
      setStatus("saved");
      doc.reload();
    } catch (e) {
      setStatus("error");
      setAliasError(e instanceof Error ? e.message : String(e));
    }
  };

  const toggleFavorite = async () => {
    try {
      await setFavorite(d.key, !d.favorite);
      doc.reload();
    } catch (e) {
      alert(`お気に入りの更新に失敗しました: ${e instanceof Error ? e.message : String(e)}`);
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

  const keys: Record<string, () => void> = {
    s: () => void toggleFavorite(),
    "#": () => void remove(),
    u: () => navigate("/docs"),
  };
  // E enters the editing scope; Escape (handled by the editor) leaves it again
  if (markdown) {
    keys.e = () => document.querySelector<HTMLElement>('.editor [contenteditable="true"]')?.focus();
  }
  docKeys.current = keys;

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
              if (e.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                (e.currentTarget as HTMLElement).blur();
              } else if (e.key === "Escape") {
                // Cancel the rename: restore the saved title, then leave the field
                const el = e.currentTarget as HTMLElement;
                el.textContent = d.title;
                el.blur();
              }
            }}
          >
            {d.title}
          </h1>
          <div class="doc-actions">
            <span class={`save-status ${status}`}>{SAVE_LABEL[status]}</span>
            <button
              type="button"
              class={`icon-btn favorite-toggle${d.favorite ? " on" : ""}`}
              aria-pressed={d.favorite}
              aria-label={d.favorite ? "お気に入りから外す" : "お気に入りに追加"}
              title={d.favorite ? "お気に入りから外す" : "お気に入りに追加"}
              onClick={() => void toggleFavorite()}
            >
              <Star size={16} fill={d.favorite ? "currentColor" : "none"} />
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
              <dt>パス</dt>
              <dd>
                <InlineEditField
                  display={d.path === "" ? <span class="muted">bucket 直下</span> : d.path}
                  value={d.path}
                  placeholder="db/sqlite（空欄で bucket 直下）"
                  title="クリックして移動"
                  list="kura-path-options"
                  onSave={moveTo}
                  onCancel={() => setPathError(null)}
                  error={pathError}
                >
                  <datalist id="kura-path-options">
                    {[...new Set(treePaths(tree.data ?? []))].sort().map((p) => (
                      <option key={p} value={p} />
                    ))}
                  </datalist>
                </InlineEditField>
              </dd>
            </div>
            <div>
              <dt>別名</dt>
              <dd>
                <InlineEditField
                  display={
                    d.aliases.length === 0 ? <span class="muted">なし</span> : d.aliases.join(", ")
                  }
                  value={d.aliases.join(", ")}
                  placeholder="別名1, 別名2"
                  title="クリックして編集"
                  onSave={saveAliases}
                  onCancel={() => setAliasError(null)}
                  error={aliasError}
                />
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
        {/* Quiet by design: last in the sidebar, and only red once you reach for it */}
        <button type="button" class="doc-delete" onClick={() => void remove()}>
          <Trash2 size={14} />
          このドキュメントを削除
        </button>
      </aside>
    </div>
  );
}
