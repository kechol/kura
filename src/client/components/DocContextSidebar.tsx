import { Plus, X } from "lucide-preact";
import { useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { type DocDetail, fetchDocs, fetchTags, updateDoc } from "../api";
import { useBucket } from "../bucket";
import { useAsync } from "../hooks";
import { DocLinkList } from "./DocLink";

const TAG_SECTIONS = 3;
const PER_SECTION = 6;
const SIBLINGS = 10;

/** Parent path of a document ("db/sqlite" → "db"); "" for a document at the bucket root */
function parentPath(path: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? "" : path.slice(0, at);
}

/**
 * Sidebar for the document being read: its tags (add / remove here), and the documents that
 * share a tag or sit in the same path. Tags are written with the full desired array — the PUT
 * contract diffs it (docs: http-api.md).
 */
export function DocContextSidebar({ doc, onChange }: { doc: DocDetail; onChange: () => void }) {
  const { bucket } = useBucket();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const allTags = useAsync(() => fetchTags(bucket), [bucket]);
  const byTag = useAsync(
    () =>
      Promise.all(
        doc.tags
          .slice(0, TAG_SECTIONS)
          .map((tag) =>
            fetchDocs({ bucket, tag, per: PER_SECTION }).then((r) => ({ tag, docs: r.docs })),
          ),
      ),
    [doc.key, doc.tags.join(","), bucket],
  );
  const siblingPath = parentPath(doc.path);
  const siblings = useAsync(
    () => fetchDocs({ bucket, prefix: siblingPath || undefined, per: SIBLINGS }),
    [doc.key, siblingPath, bucket],
  );

  const writeTags = async (tags: string[]) => {
    setError(null);
    try {
      const updated = await updateDoc(doc.key, { tags });
      // An inline #hashtag in the body is re-extracted on save, so a removal can come back
      const stuck = doc.tags.filter((t) => !tags.includes(t) && updated.tags.includes(t));
      if (stuck.length > 0) {
        setError(`本文の #${stuck[0]} が残っているため、タグを外せませんでした`);
      }
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const add = async (e: Event) => {
    e.preventDefault();
    const tag = value.trim().replace(/^#/, "");
    if (tag === "" || doc.tags.includes(tag)) return;
    setValue("");
    setAdding(false);
    await writeTags([...doc.tags, tag]);
  };

  return (
    <>
      <section class="sidebar-section">
        <h2>タグ</h2>
        <div class="tag-cell">
          {doc.tags.map((t) => (
            <span class="tag-chip editable" key={t}>
              <Link href={`/docs?tag=${encodeURIComponent(t)}`}>#{t}</Link>
              <button
                type="button"
                class="tag-remove"
                aria-label={`${t} を外す`}
                onClick={() => void writeTags(doc.tags.filter((x) => x !== t))}
              >
                <X size={11} />
              </button>
            </span>
          ))}
          {!adding && (
            <button
              type="button"
              class="tag-chip add"
              aria-label="タグを追加"
              onClick={() => setAdding(true)}
            >
              <Plus size={12} />
            </button>
          )}
        </div>
        {adding && (
          <form class="tag-add-form" onSubmit={add}>
            <input
              type="text"
              list="kura-tag-options"
              placeholder="tech/db など"
              value={value}
              // biome-ignore lint/a11y/noAutofocus: the field only exists once the user asks for it
              autoFocus
              onInput={(e) => setValue((e.target as HTMLInputElement).value)}
              onBlur={() => value.trim() === "" && setAdding(false)}
            />
            <datalist id="kura-tag-options">
              {(allTags.data ?? []).map((t) => (
                <option key={t.path} value={t.path} />
              ))}
            </datalist>
          </form>
        )}
        {error !== null && <p class="error">{error}</p>}
      </section>

      {(byTag.data ?? []).map(({ tag, docs }) => (
        <section class="sidebar-section" key={tag}>
          <h2>#{tag}</h2>
          <DocLinkList docs={docs} class="sidebar-docs" exclude={doc.key} />
        </section>
      ))}

      <section class="sidebar-section">
        <h2>{siblingPath === "" ? "同じ階層（直下）" : `同じ階層（${siblingPath}）`}</h2>
        <DocLinkList docs={siblings.data?.docs ?? []} class="sidebar-docs" exclude={doc.key} />
      </section>
    </>
  );
}
