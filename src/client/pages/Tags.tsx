import { fetchTagTree } from "../api";
import { TagTree } from "../components/TagTree";
import { useAsync } from "../hooks";

export function TagsPage() {
  const tree = useAsync(fetchTagTree, []);
  return (
    <div class="page">
      <h1>タグブラウザ</h1>
      <p class="muted">件数は「直接付与 / 子孫含む合計」。クリックで一覧を絞り込みます。</p>
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
