import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { fetchBuckets, fetchTagTree } from "../api";
import { useAsync } from "../hooks";
import { currentTheme, setTheme, type Theme } from "../theme";
import { TagTree } from "./TagTree";

/** Shared layout: header (search, theme toggle) + left sidebar (buckets / tag tree) */
export function Layout({ children }: { children: ComponentChildren }) {
  const [location, navigate] = useLocation();
  // Refetch on every navigation to keep counts current (cheap against the local API)
  const buckets = useAsync(fetchBuckets, [location]);
  const tags = useAsync(fetchTagTree, [location]);
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
        <button type="button" class="theme-toggle" onClick={toggleTheme}>
          {theme === "dark" ? "ライト" : "ダーク"}
        </button>
      </header>
      <div class="layout-body">
        <aside class="sidebar">
          <section class="sidebar-section">
            <h2>Bucket</h2>
            <ul class="bucket-list">
              {(buckets.data ?? []).map((b) => (
                <li key={b.name}>
                  <Link href={`/docs?bucket=${encodeURIComponent(b.name)}`}>
                    {b.name} <span class="count">{b.documents}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
          <section class="sidebar-section">
            <h2>タグ</h2>
            <TagTree nodes={tags.data ?? []} />
          </section>
        </aside>
        <main class="main">{children}</main>
      </div>
    </div>
  );
}
