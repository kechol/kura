import { Plus, X } from "lucide-preact";
import { useState } from "preact/hooks";
import { Link } from "wouter-preact";
import { type DocDetail, fetchTags, updateDoc } from "../api";
import { useBucket } from "../bucket";
import { focusOnMount, useAsync } from "../hooks";

/**
 * The open document's tags, added and removed in place. Tags are written with the full desired
 * array — the PUT contract diffs it (docs: http-api.md).
 */
export function DocTags({ doc, onChange }: { doc: DocDetail; onChange: () => void }) {
  const { bucket } = useBucket();
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const allTags = useAsync(
    () => (adding ? fetchTags(bucket) : Promise.resolve([])),
    [bucket, adding],
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
      <div class="tag-cell">
        {doc.tags.map((t) => (
          <span class="tag-chip editable" key={t}>
            <Link class="tag-chip-link" href={`/docs?tag=${encodeURIComponent(t)}`}>
              #{t}
            </Link>
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
            aria-label="追加するタグ"
            list="kura-tag-options"
            placeholder="tech/db など"
            value={value}
            ref={focusOnMount}
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
      {error !== null && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}
