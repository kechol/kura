import { FilePlus, Keyboard, Menu, Moon, Search, Sun } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import { fetchDocTree, fetchFavorites, fetchTagTree } from "../api";
import { useBucket } from "../bucket";
import { useCurrentDoc } from "../currentdoc";
import { useAsync } from "../hooks";
import { useModal } from "../modal";
import { currentTheme, setTheme, type Theme } from "../theme";
import { DocContextSidebar } from "./DocContextSidebar";
import { DocTree } from "./DocTree";
import { FavoriteTree } from "./FavoriteTree";
import { TagTree } from "./TagTree";

const NAV_ITEMS: Array<[string, string]> = [
  ["/docs", "ドキュメント"],
  ["/search", "検索"],
  ["/tags", "タグ"],
  ["/graph", "グラフ"],
  ["/stats", "統計"],
];

/**
 * Shared layout: header (search / new) + left sidebar (bucket picker / favorites /
 * doc tree / tag tree / theme + shortcuts).
 */
export function Layout({ children }: { children: ComponentChildren }) {
  const [location] = useLocation();
  const { bucket, buckets, setBucket, loading } = useBucket();
  const modal = useModal();
  const currentDoc = useCurrentDoc();
  // Every tree is scoped to the selected bucket; refetch on navigation to keep counts current.
  // On a document the tag tree gives way to that document's own sidebar, so it is not fetched.
  const showTagTree = currentDoc.doc === null;
  // Starring, renaming or moving the open document reshapes the trees without navigating,
  // so the fields the trees are built from are part of what they refetch on.
  const open = currentDoc.doc;
  const docSignature =
    open === null ? "" : `${open.key}:${open.path}:${open.title}:${open.favorite}`;
  const tags = useAsync(
    () => (bucket === "" || !showTagTree ? Promise.resolve([]) : fetchTagTree(bucket)),
    [location, bucket, showTagTree],
  );
  const docTree = useAsync(
    () => (bucket === "" ? Promise.resolve([]) : fetchDocTree(bucket)),
    [location, bucket, docSignature],
  );
  const favorites = useAsync(
    () => (bucket === "" ? Promise.resolve([]) : fetchFavorites(bucket)),
    [location, bucket, docSignature],
  );
  const [theme, setThemeState] = useState<Theme>(currentTheme());

  // A client-side route change leaves focus on a link that may be gone, and nothing tells a
  // screen reader the page changed. Back/forward keeps the scroll position the browser restores.
  const mainRef = useRef<HTMLElement>(null);
  const previousLocation = useRef(location);
  const [menuOpen, setMenuOpen] = useState(false);
  const popped = useRef(false);
  useEffect(() => {
    const onPopState = () => {
      popped.current = true;
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    if (previousLocation.current === location) return;
    previousLocation.current = location;
    setMenuOpen(false);
    mainRef.current?.focus({ preventScroll: true });
    if (!popped.current) window.scrollTo(0, 0);
    popped.current = false;
  }, [location]);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

  return (
    <div class="layout">
      <a class="skip-link" href="#main">
        本文へ移動
      </a>
      <div id="route-announcer" class="sr-only" role="status" />
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
        <button
          type="button"
          class="icon-btn menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          aria-label="サイドバー"
          title="サイドバー"
          onClick={() => setMenuOpen((open) => !open)}
        >
          <Menu size={16} />
        </button>
        <nav class="nav" aria-label="メイン">
          {NAV_ITEMS.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              aria-current={
                location === href ? "page" : location.startsWith(`${href}/`) ? "true" : undefined
              }
            >
              {label}
            </Link>
          ))}
        </nav>
      </header>
      <div class="layout-body">
        <aside id="sidebar" class={`sidebar${menuOpen ? " open" : ""}`} aria-label="サイドバー">
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
          {/* Pinned on every screen, so a favorite is always one click away */}
          <section class="sidebar-section">
            <h2>お気に入り</h2>
            <FavoriteTree favorites={favorites.data ?? []} tree={docTree.data ?? []} />
          </section>
          <section class="sidebar-section">
            <h2>ドキュメント</h2>
            <DocTree nodes={docTree.data ?? []} />
          </section>
          {/* On a document, the tag tree gives way to that document's neighbours */}
          {currentDoc.doc !== null ? (
            <DocContextSidebar doc={currentDoc.doc} />
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
              onClick={() => modal.open("shortcuts")}
              aria-label="ショートカット一覧（Ctrl + ?）"
              title="ショートカット一覧（Ctrl + ?）"
            >
              <Keyboard size={16} />
            </button>
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
        <main id="main" class="main" tabIndex={-1} ref={mainRef}>
          {bucket === "" && loading ? <p class="empty">読み込み中…</p> : children}
        </main>
      </div>
    </div>
  );
}
