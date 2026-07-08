import { useState } from "preact/hooks";
import { Link, useLocation, useSearch } from "wouter-preact";
import { fetchBuckets, fetchDocs } from "../api";
import { formatDate } from "../format";
import { useAsync } from "../hooks";

const PER = 20;

const SORT_LABELS: Array<[string, string]> = [
  ["updated", "更新順"],
  ["created", "作成順"],
  ["accessed", "参照順"],
  ["title", "タイトル順"],
];

export function DocList() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const bucket = params.get("bucket") ?? "";
  const tag = params.get("tag") ?? "";
  const sort = params.get("sort") ?? "updated";
  const stale = params.get("stale") === "1";
  const page = Math.max(Number.parseInt(params.get("page") ?? "1", 10) || 1, 1);
  const [tagInput, setTagInput] = useState(tag);

  const buckets = useAsync(fetchBuckets, []);
  const result = useAsync(
    () =>
      fetchDocs({
        bucket: bucket || undefined,
        tag: tag || undefined,
        sort,
        stale,
        page,
        per: PER,
      }),
    [search],
  );

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in patch)) next.delete("page"); // フィルタ変更時は 1 ページ目へ
    const qs = next.toString();
    navigate(`/docs${qs === "" ? "" : `?${qs}`}`);
  };

  const total = result.data?.total ?? 0;
  const totalPages = Math.max(Math.ceil(total / PER), 1);

  return (
    <div class="page">
      <h1>ドキュメント一覧</h1>
      <div class="filter-bar">
        <label>
          Bucket:
          <select
            value={bucket}
            onChange={(e) => update({ bucket: (e.target as HTMLSelectElement).value })}
          >
            <option value="">すべて</option>
            {(buckets.data ?? []).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <form
          class="tag-filter"
          onSubmit={(e) => {
            e.preventDefault();
            update({ tag: tagInput.trim() });
          }}
        >
          <label>
            タグ:
            <input
              type="text"
              placeholder="tech/db など"
              value={tagInput}
              onInput={(e) => setTagInput((e.target as HTMLInputElement).value)}
            />
          </label>
          <button type="submit" class="btn">
            絞り込む
          </button>
          {tag !== "" && (
            <button
              type="button"
              class="btn"
              onClick={() => {
                setTagInput("");
                update({ tag: "" });
              }}
            >
              解除
            </button>
          )}
        </form>
        <label>
          ソート:
          <select
            value={sort}
            onChange={(e) => update({ sort: (e.target as HTMLSelectElement).value })}
          >
            {SORT_LABELS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label class="checkbox-label">
          <input
            type="checkbox"
            checked={stale}
            onChange={(e) => update({ stale: (e.target as HTMLInputElement).checked ? "1" : "" })}
          />
          陳腐化候補のみ
        </label>
      </div>

      {result.error && <p class="error">{result.error}</p>}
      {result.loading && <p class="empty">読み込み中…</p>}
      {result.data && result.data.docs.length === 0 && (
        <p class="empty">該当するドキュメントはありません</p>
      )}
      {result.data && result.data.docs.length > 0 && (
        <div class="table-wrap">
          <table class="doc-table">
            <thead>
              <tr>
                <th>タイトル</th>
                <th>Bucket</th>
                <th>タグ</th>
                <th>更新日</th>
                <th>参照数</th>
              </tr>
            </thead>
            <tbody>
              {result.data.docs.map((d) => (
                <tr key={d.key}>
                  <td>
                    <Link href={`/docs/${encodeURIComponent(d.key)}`}>{d.title}</Link>
                  </td>
                  <td>{d.bucket}</td>
                  <td>
                    <span class="tag-cell">
                      {d.tags.map((t) => (
                        <Link key={t} class="tag-chip" href={`/docs?tag=${encodeURIComponent(t)}`}>
                          #{t}
                        </Link>
                      ))}
                    </span>
                  </td>
                  <td>{formatDate(d.updated_at)}</td>
                  <td class="num">{d.access_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {total > PER && (
        <div class="pagination">
          <button
            type="button"
            class="btn"
            disabled={page <= 1}
            onClick={() => update({ page: String(page - 1) })}
          >
            前へ
          </button>
          <span>
            {page} / {totalPages} ページ（全 {total} 件）
          </span>
          <button
            type="button"
            class="btn"
            disabled={page >= totalPages}
            onClick={() => update({ page: String(page + 1) })}
          >
            次へ
          </button>
        </div>
      )}
    </div>
  );
}
