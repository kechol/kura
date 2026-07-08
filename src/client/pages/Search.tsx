import { useEffect, useState } from "preact/hooks";
import { Link, useLocation, useSearch } from "wouter-preact";
import { fetchBuckets, type SearchMode, searchDocs } from "../api";
import { snippetHtml } from "../format";
import { useAsync } from "../hooks";

const MODES: Array<[SearchMode, string]> = [
  ["keyword", "キーワード"],
  ["vector", "ベクトル"],
  ["hybrid", "ハイブリッド"],
];

function parseMode(value: string | null): SearchMode {
  return value === "vector" || value === "hybrid" ? value : "keyword";
}

export function SearchPage() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const q = params.get("q") ?? "";
  const mode = parseMode(params.get("mode"));
  const bucket = params.get("bucket") ?? "";
  const tag = params.get("tag") ?? "";
  const [input, setInput] = useState(q);
  const [tagInput, setTagInput] = useState(tag);

  useEffect(() => setInput(q), [q]);
  useEffect(() => setTagInput(tag), [tag]);

  const buckets = useAsync(fetchBuckets, []);
  const result = useAsync(async () => {
    if (q.trim() === "") return null;
    return searchDocs({
      q,
      mode,
      bucket: bucket || undefined,
      tag: tag || undefined,
      limit: 30,
    });
  }, [q, mode, bucket, tag]);

  const update = (patch: Record<string, string>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === "") next.delete(k);
      else next.set(k, v);
    }
    navigate(`/search?${next.toString()}`);
  };

  return (
    <div class="page">
      <h1>検索</h1>
      <form
        class="search-page-form"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: input.trim(), tag: tagInput.trim() });
        }}
      >
        <input
          type="search"
          class="search-page-input"
          placeholder="検索クエリ…"
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
        />
        <button type="submit" class="btn btn-primary">
          検索
        </button>
      </form>

      <div class="filter-bar">
        <div class="mode-switch">
          {MODES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              class={`mode-btn${mode === value ? " active" : ""}`}
              onClick={() => update({ mode: value })}
            >
              {label}
            </button>
          ))}
        </div>
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
        <label>
          タグ:
          <input
            type="text"
            value={tagInput}
            placeholder="tech/db など"
            onInput={(e) => setTagInput((e.target as HTMLInputElement).value)}
            onChange={(e) => update({ tag: (e.target as HTMLInputElement).value.trim() })}
          />
        </label>
      </div>

      {q.trim() === "" && <p class="empty">クエリを入力してください</p>}
      {result.loading && q.trim() !== "" && <p class="empty">検索中…</p>}
      {result.error && <p class="error">{result.error}</p>}
      {result.data?.warnings.map((w) => (
        <p class="warning" key={w}>
          {w}
        </p>
      ))}
      {result.data && result.data.hits.length === 0 && <p class="empty">ヒットなし</p>}
      {result.data && result.data.hits.length > 0 && (
        <ol class="search-hits">
          {result.data.hits.map((h) => (
            <li key={h.key} class="search-hit">
              <div class="hit-head">
                <Link href={`/docs/${encodeURIComponent(h.key)}`}>{h.title}</Link>
                <span class="badge">{h.source}</span>
                <span class="score">score {h.score.toFixed(3)}</span>
                <span class="count">{h.bucket}</span>
              </div>
              {/* snippetHtml escapes first and only inserts <mark> */}
              <p class="snippet" dangerouslySetInnerHTML={{ __html: snippetHtml(h.snippet) }} />
              {h.tags.length > 0 && (
                <div class="tag-cell">
                  {h.tags.map((t) => (
                    <Link key={t} class="tag-chip" href={`/docs?tag=${encodeURIComponent(t)}`}>
                      #{t}
                    </Link>
                  ))}
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
