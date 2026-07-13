import { Moon, Sun } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { fetchDocTree, fetchTagTree } from "../api";
import { useBucket } from "../bucket";
import { useAsync } from "../hooks";
import { currentTheme, setTheme, type Theme } from "../theme";
import { DocTree } from "./DocTree";
import { TagTree } from "./TagTree";

/** Shared layout: header (search) + left sidebar (bucket picker / doc tree / tag tree / theme) */
export function Layout({ children }: { children: ComponentChildren }) {
  const [location, navigate] = useLocation();
  const { bucket, buckets, setBucket, loading } = useBucket();
  // Every tree is scoped to the selected bucket; refetch on navigation to keep counts current
  const tags = useAsync(
    () => (bucket === "" ? Promise.resolve([]) : fetchTagTree(bucket)),
    [location, bucket],
  );
  const docTree = useAsync(
    () => (bucket === "" ? Promise.resolve([]) : fetchDocTree(bucket)),
    [location, bucket],
  );
  const [theme, setThemeState] = useState<Theme>(currentTheme());
  const [q, setQ] = useState("");

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  const submitSearch = (e: Event) => {
    e.preventDefault();
    const query = q.trim();
    if (query !== "") navigate(`/search?q=${encodeURIComponent(query)}`);
  };

  return (
    <div class="layout">
      <header class="header">
        <Link href="/" class="brand">
          kura
        </Link>
        <nav class="nav">
          <Link href="/docs">ドキュメント</Link>
          <Link href="/tags">タグ</Link>
          <Link href="/graph">グラフ</Link>
        </nav>
        <form class="search-form" onSubmit={submitSearch}>
          <input
            type="search"
            placeholder="検索…"
            value={q}
            onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          />
        </form>
      </header>
      <div class="layout-body">
        <aside class="sidebar">
          <section class="sidebar-section">
            <h2>Bucket</h2>
            <select
              class="bucket-select"
              aria-label="Bucket を選択"
              value={bucket}
              onChange={(e) => setBucket((e.target as HTMLSelectElement).value)}
            >
              {buckets.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}（{b.documents}）
                </option>
              ))}
            </select>
          </section>
          <section class="sidebar-section">
            <h2>ドキュメント</h2>
            <DocTree nodes={docTree.data ?? []} />
          </section>
          <section class="sidebar-section">
            <h2>タグ</h2>
            <TagTree nodes={tags.data ?? []} />
          </section>
          <div class="sidebar-footer">
            <button
              type="button"
              class="icon-btn"
              onClick={toggleTheme}
              aria-label={theme === "dark" ? "ライトテーマに切替" : "ダークテーマに切替"}
              title={theme === "dark" ? "ライトテーマに切替" : "ダークテーマに切替"}
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
          </div>
        </aside>
        {/* Hold the screens back until the bucket resolves, so no list is ever rendered unscoped */}
        <main class="main">
          {bucket === "" && loading ? <p class="empty">読み込み中…</p> : children}
        </main>
      </div>
    </div>
  );
}
