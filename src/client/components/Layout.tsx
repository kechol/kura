import { FilePlus, Keyboard, Moon, Search, Sun } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useState } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { fetchDocTree, fetchTagTree } from "../api";
import { useBucket } from "../bucket";
import { useCurrentDoc } from "../currentdoc";
import { useAsync } from "../hooks";
import { useModal } from "../modal";
import { currentTheme, setTheme, type Theme } from "../theme";
import { DocContextSidebar } from "./DocContextSidebar";
import { DocTree } from "./DocTree";
import { TagTree } from "./TagTree";

/** Shared layout: header (search) + left sidebar (bucket picker / doc tree / tag tree / theme) */
export function Layout({ children }: { children: ComponentChildren }) {
  const [location] = useLocation();
  const { bucket, buckets, setBucket, loading } = useBucket();
  const modal = useModal();
  const currentDoc = useCurrentDoc();
  // Every tree is scoped to the selected bucket; refetch on navigation to keep counts current.
  // On a document the tag tree gives way to that document's own sidebar, so it is not fetched.
  const showTagTree = currentDoc.doc === null;
  const tags = useAsync(
    () => (bucket === "" || !showTagTree ? Promise.resolve([]) : fetchTagTree(bucket)),
    [location, bucket, showTagTree],
  );
  const docTree = useAsync(
    () => (bucket === "" ? Promise.resolve([]) : fetchDocTree(bucket)),
    [location, bucket],
  );
  const [theme, setThemeState] = useState<Theme>(currentTheme());

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  return (
    <div class="layout">
      <header class="header">
        <Link href="/" class="brand">
          kura
        </Link>
        <button
          type="button"
          class="icon-btn search-trigger"
          onClick={() => modal.open("search")}
          aria-label="検索（Ctrl + P）"
          title="検索（Ctrl + P）"
        >
          <Search size={16} />
        </button>
        <button
          type="button"
          class="icon-btn"
          onClick={modal.createUntitled}
          aria-label="新しいドキュメント（Ctrl + N）"
          title="新しいドキュメント（Ctrl + N）"
        >
          <FilePlus size={16} />
        </button>
        <nav class="nav">
          <Link href="/docs">ドキュメント</Link>
          <Link href="/tags">タグ</Link>
          <Link href="/graph">グラフ</Link>
          <Link href="/stats">統計</Link>
        </nav>
        <button
          type="button"
          class="icon-btn header-help"
          onClick={() => modal.open("shortcuts")}
          aria-label="ショートカット一覧（Ctrl + ?）"
          title="ショートカット一覧（Ctrl + ?）"
        >
          <Keyboard size={16} />
        </button>
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
          {/* On a document, the tag tree gives way to that document's own tags and neighbours */}
          {currentDoc.doc !== null ? (
            <DocContextSidebar doc={currentDoc.doc} onChange={currentDoc.reload} />
          ) : (
            <section class="sidebar-section">
              <h2>タグ</h2>
              <TagTree nodes={tags.data ?? []} />
            </section>
          )}
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
