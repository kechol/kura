import { fetchTagTree } from "../api";
import { useBucket } from "../bucket";
import { TagTree } from "../components/TagTree";
import { useAsync, useDocumentTitle } from "../hooks";

export function TagsPage() {
  useDocumentTitle("タグ");
  const { bucket } = useBucket();
  const tree = useAsync(() => fetchTagTree(bucket), [bucket]);
  return (
    <div class="page">
      <h1>タグブラウザ</h1>
      <p class="muted">
        件数は「直接付与 / 子孫含む合計」。選択中の Bucket
        内で数えています。クリックで一覧を絞り込みます。
      </p>
      {tree.error && <p class="error">{tree.error}</p>}
      {tree.loading ? (
        <p class="empty">読み込み中…</p>
      ) : (
        <div class="tags-page-tree">
          <TagTree nodes={tree.data ?? []} detail />
        </div>
      )}
    </div>
  );
}
