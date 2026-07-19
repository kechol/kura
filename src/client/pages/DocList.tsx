import { useState } from "preact/hooks";
import { Link, useLocation, useSearch } from "wouter-preact";
import { fetchDocs } from "../api";
import { useBucket } from "../bucket";
import { docHref } from "../components/DocLink";
import { formatDate } from "../format";
import { useAsync, useDocumentTitle, usePageListNavigation } from "../hooks";
import { useModal } from "../modal";

const PER = 20;

const SORT_LABELS: Array<[string, string]> = [
  ["updated", "更新順"],
  ["created", "作成順"],
  ["accessed", "参照順"],
  ["title", "タイトル順"],
];

export function DocList() {
  useDocumentTitle("ドキュメント");
  const search = useSearch();
  const [, navigate] = useLocation();
  const { bucket } = useBucket();
  const params = new URLSearchParams(search);
  const tag = params.get("tag") ?? "";
  const prefix = params.get("prefix") ?? "";
  const sort = params.get("sort") ?? "updated";
  const stale = params.get("stale") === "1";
  const page = Math.max(Number.parseInt(params.get("page") ?? "1", 10) || 1, 1);
  const [tagInput, setTagInput] = useState(tag);
  const [prefixInput, setPrefixInput] = useState(prefix);

  const result = useAsync(
    () =>
      fetchDocs({
        bucket,
        tag: tag || undefined,
        prefix: prefix || undefined,
        sort,
        stale,
        page,
        per: PER,
      }),
    [search, bucket],
  );

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") next.delete(k);
      else next.set(k, v);
    }
    if (!("page" in patch)) next.delete("page"); // Reset to page 1 when filters change
    const qs = next.toString();
    navigate(`/docs${qs === "" ? "" : `?${qs}`}`);
  };

  const total = result.data?.total ?? 0;
  const totalPages = Math.max(Math.ceil(total / PER), 1);

  const modal = useModal();
  const cursor = usePageListNavigation(result.data?.docs, (d) => navigate(docHref(d.key)), {
    disabled: modal.isOpen,
    onPage: (delta) => {
      const next = page + delta;
      if (next >= 1 && next <= totalPages) update({ page: String(next) });
    },
  });

  return (
    <div class="page">
      <h1>ドキュメント一覧</h1>
      <div class="filter-bar">
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
        <form
          class="tag-filter"
          onSubmit={(e) => {
            e.preventDefault();
            update({ prefix: prefixInput.trim() });
          }}
        >
          <label>
            パス:
            <input
              type="text"
              placeholder="clips/技術 など"
              value={prefixInput}
              onInput={(e) => setPrefixInput((e.target as HTMLInputElement).value)}
            />
          </label>
          <button type="submit" class="btn">
            絞り込む
          </button>
          {prefix !== "" && (
            <button
              type="button"
              class="btn"
              onClick={() => {
                setPrefixInput("");
                update({ prefix: "" });
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
                <th>タグ</th>
                <th>更新日</th>
                <th>参照数</th>
              </tr>
            </thead>
            <tbody>
              {result.data.docs.map((d, i) => (
                <tr key={d.key} class={i === cursor ? "kbd-cursor" : undefined}>
                  <td>
                    <Link href={`/docs/${encodeURIComponent(d.key)}`}>
                      {d.path !== "" && <span class="doc-path-prefix">{d.path}/</span>}
                      {d.title}
                    </Link>
                  </td>
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
