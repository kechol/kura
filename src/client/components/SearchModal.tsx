import { Search, X } from "lucide-preact";
import { useMemo, useState } from "preact/hooks";
import { useLocation } from "wouter-preact";
import { fetchRecentDocs, fetchTags, qs, searchDocs } from "../api";
import { useBucket } from "../bucket";
import { snippetHtml } from "../format";
import { useAsync, useDebounced, useListNavigation } from "../hooks";
import { DocTitle, docHref } from "./DocLink";
import { Modal, ModalHints } from "./Modal";

const DEBOUNCE_MS = 150;
const LIMIT = 20;

type Tab = "docs" | "tags";

interface DocItem {
  key: string;
  title: string;
  path: string;
  snippet?: string;
}

interface TagItem {
  path: string;
  count: number;
}

/**
 * Raycast-style search: results update on every keystroke. The API is local, so a
 * 150 ms debounce against `/api/search` is instant in practice and keeps the vaporetto
 * morphological tokenizer and BM25 snippets that a client-side index could not reproduce
 * (docs: browser-ui.md). Keyword mode only — vector / hybrid live on the /search page.
 */
export function SearchModal({ onClose }: { onClose: () => void }) {
  const [, navigate] = useLocation();
  const { bucket } = useBucket();
  const [tab, setTab] = useState<Tab>("docs");
  const [q, setQ] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const debounced = useDebounced(q, DEBOUNCE_MS);
  const term = debounced.trim();

  const docs = useAsync(async (): Promise<DocItem[]> => {
    if (tab !== "docs") return [];
    // Empty query: offer the reading history instead of nothing
    if (term === "") {
      const recent = await fetchRecentDocs(bucket, { limit: 10, tag: tagFilter || undefined });
      return recent.map((d) => ({ key: d.key, title: d.title, path: d.path }));
    }
    const res = await searchDocs({
      q: term,
      mode: "keyword",
      bucket,
      tag: tagFilter || undefined,
      limit: LIMIT,
    });
    return res.hits.map((h) => ({
      key: h.key,
      title: h.title,
      path: h.path,
      snippet: h.snippet,
    }));
  }, [tab, term, tagFilter, bucket]);

  // The tag list is small: fetch once per bucket and filter in the browser
  const allTags = useAsync(() => fetchTags(bucket), [bucket]);
  const tags: TagItem[] = useMemo(
    () => (allTags.data ?? []).filter((t) => t.path.toLowerCase().includes(q.trim().toLowerCase())),
    [allTags.data, q],
  );

  const openDoc = (d: DocItem) => {
    navigate(docHref(d.key));
    onClose();
  };
  // Vector and hybrid need the full page; carry over what has been typed so far
  const openSearchPage = () => {
    navigate(`/search${qs({ mode: "hybrid", q: q.trim(), tag: tagFilter })}`);
    onClose();
  };
  const filterByTag = (t: TagItem) => {
    setTagFilter(t.path);
    setTab("docs");
  };

  // One navigator over whichever tab is showing — a second one would keep an index nobody reads
  const items: Array<DocItem | TagItem> = tab === "docs" ? (docs.data ?? []) : tags;
  const nav = useListNavigation<DocItem | TagItem>(items, (item) =>
    "key" in item ? openDoc(item) : filterByTag(item),
  );
  const activeItem = items[nav.index];

  return (
    <Modal label="検索" onClose={onClose}>
      <div class="search-modal-head">
        <Search size={18} class="search-modal-icon" />
        <input
          type="text"
          class="search-modal-input"
          aria-label={tab === "docs" ? "ドキュメントを検索" : "タグを絞り込む"}
          placeholder={tab === "docs" ? "ドキュメントを検索…" : "タグを絞り込む…"}
          value={q}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={nav.onKeyDown}
        />
      </div>

      <div class="search-modal-bar">
        {/* biome-ignore lint/a11y/useSemanticElements: a <fieldset> would need a visible legend */}
        <div class="modal-tabs" role="group" aria-label="検索対象">
          <button
            type="button"
            class={`modal-tab${tab === "docs" ? " active" : ""}`}
            aria-pressed={tab === "docs"}
            onClick={() => setTab("docs")}
          >
            ドキュメント
          </button>
          <button
            type="button"
            class={`modal-tab${tab === "tags" ? " active" : ""}`}
            aria-pressed={tab === "tags"}
            onClick={() => setTab("tags")}
          >
            タグ
          </button>
        </div>
        {tagFilter !== "" && (
          <button
            type="button"
            class="filter-chip"
            aria-label={`タグの絞り込み #${tagFilter} を解除`}
            onClick={() => setTagFilter("")}
          >
            #{tagFilter}
            <X size={12} />
          </button>
        )}
        <span class="search-modal-bucket">{bucket}</span>
      </div>

      {/* Focus stays in the input while the arrows move, so the cursor is announced here */}
      <span class="sr-only" role="status">
        {`${items.length} 件`}
        {activeItem !== undefined &&
          `、選択中: ${"key" in activeItem ? activeItem.title : `#${activeItem.path}`}`}
      </span>

      <div class="modal-results">
        {tab === "docs" && (
          <>
            {docs.error && (
              <p class="error" role="alert">
                {docs.error}
              </p>
            )}
            {!docs.loading && (docs.data ?? []).length === 0 && (
              <p class="empty">{term === "" ? "履歴がありません" : "ヒットなし"}</p>
            )}
            <ul class="result-list">
              {(docs.data ?? []).map((d, i) => (
                <li key={d.key}>
                  <button
                    type="button"
                    class={`result-row${i === nav.index ? " active" : ""}`}
                    onMouseEnter={() => nav.setIndex(i)}
                    onFocus={() => nav.setIndex(i)}
                    onClick={() => openDoc(d)}
                  >
                    <span class="result-title">
                      <DocTitle doc={d} />
                    </span>
                    {d.snippet !== undefined && d.snippet !== "" && (
                      // snippetHtml escapes first and only inserts <mark>
                      <span
                        class="result-snippet"
                        dangerouslySetInnerHTML={{ __html: snippetHtml(d.snippet) }}
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {tab === "tags" && (
          <>
            {allTags.error && (
              <p class="error" role="alert">
                {allTags.error}
              </p>
            )}
            {!allTags.loading && tags.length === 0 && <p class="empty">該当するタグなし</p>}
            <ul class="result-list">
              {tags.map((t, i) => (
                <li key={t.path}>
                  <button
                    type="button"
                    class={`result-row${i === nav.index ? " active" : ""}`}
                    onMouseEnter={() => nav.setIndex(i)}
                    onFocus={() => nav.setIndex(i)}
                    onClick={() => filterByTag(t)}
                  >
                    <span class="result-title">#{t.path}</span>
                    <span class="count">{t.count}</span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <button type="button" class="search-modal-more" onClick={openSearchPage}>
        検索画面でハイブリッド検索 →
      </button>

      <ModalHints
        hints={[
          ["↑↓", "移動"],
          ["Enter", tab === "docs" ? "開く" : "このタグで絞る"],
          ["Esc", "閉じる"],
        ]}
      />
    </Modal>
  );
}
