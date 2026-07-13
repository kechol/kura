import { useEffect, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { fetchDoc, updateDoc } from "../api";
import { useAsync, useDocumentTitle } from "../hooks";

export function DocEdit({ docKey }: { docKey: string }) {
  const [, navigate] = useLocation();
  const doc = useAsync(() => fetchDoc(docKey), [docKey]);
  useDocumentTitle(doc.data ? `${doc.data.title}（編集）` : null);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Populate the form with the fetched document (once per key)
  useEffect(() => {
    if (doc.data && loadedKey !== doc.data.key) {
      setTitle(doc.data.title);
      setContent(doc.data.content);
      setTags(doc.data.tags.join(", "));
      setLoadedKey(doc.data.key);
    }
  }, [doc.data, loadedKey]);

  if (doc.loading && loadedKey === null) return <p class="empty">読み込み中…</p>;
  if (doc.error) return <p class="error">{doc.error}</p>;

  const save = async (e: Event) => {
    e.preventDefault();
    if (title.trim() === "") {
      setError("タイトルを入力してください");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const tagList = tags
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
      await updateDoc(docKey, { title: title.trim(), content, tags: tagList });
      navigate(`/docs/${encodeURIComponent(docKey)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  return (
    <div class="page">
      <h1>編集</h1>
      {error && <p class="error">{error}</p>}
      <form class="edit-form" onSubmit={save}>
        <label>
          タイトル
          <input
            type="text"
            value={title}
            onInput={(e) => setTitle((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          タグ（カンマ区切り）
          <input
            type="text"
            placeholder="tech/db, レビュー済み"
            value={tags}
            onInput={(e) => setTags((e.target as HTMLInputElement).value)}
          />
        </label>
        <label>
          本文
          <textarea
            rows={24}
            value={content}
            onInput={(e) => setContent((e.target as HTMLTextAreaElement).value)}
          />
        </label>
        <div class="edit-actions">
          <button type="submit" class="btn btn-primary" disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
          <button
            type="button"
            class="btn"
            onClick={() => navigate(`/docs/${encodeURIComponent(docKey)}`)}
          >
            キャンセル
          </button>
        </div>
      </form>
    </div>
  );
}
