import { Star } from "lucide-preact";
import { useState } from "preact/hooks";
import { Link } from "wouter-preact";
import type { DocMeta, DocTreeNode } from "../api";
import { DocTreeList } from "./DocTree";

/** Full path of a document ("db/sqlite" + "WAL" → "db/sqlite/WAL"); mirrors joinDocPath in core */
function fullPath(doc: DocMeta): string {
  return doc.path === "" ? doc.title : `${doc.path}/${doc.title}`;
}

/** The bucket tree node standing for this document (case-insensitive, like every path comparison) */
function findNode(nodes: DocTreeNode[], path: string): DocTreeNode | null {
  for (const n of nodes) {
    if (n.path.toLowerCase() === path) return n;
    // Only descend where the answer can be: branches are prefixes of their children
    if (path.startsWith(`${n.path.toLowerCase()}/`)) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
}

interface Props {
  favorites: DocMeta[];
  /** The bucket's document tree, reused to hang each favorite's subtree off it */
  tree: DocTreeNode[];
}

/**
 * Favorites, pinned above the document tree on every screen. A favorite is rooted at
 * its own full path, so the documents filed *under* it (the tree node it merges with)
 * expand beneath it — a favorite with nothing under it is just a link.
 */
export function FavoriteTree({ favorites, tree }: Props) {
  if (favorites.length === 0) {
    return <p class="empty">★ を付けたドキュメントがここに並びます</p>;
  }
  return (
    <ul class="tag-tree doc-tree">
      {favorites.map((doc) => (
        <FavoriteItem key={doc.key} doc={doc} node={findNode(tree, fullPath(doc).toLowerCase())} />
      ))}
    </ul>
  );
}

function FavoriteItem({ doc, node }: { doc: DocMeta; node: DocTreeNode | null }) {
  const [open, setOpen] = useState(false);
  const children = node?.children ?? [];
  const hasChildren = children.length > 0;
  return (
    <li>
      <div class="doc-tree-row">
        {hasChildren ? (
          <button
            type="button"
            class="doc-tree-toggle"
            aria-expanded={open}
            aria-label={open ? "折りたたむ" : "展開する"}
            onClick={() => setOpen(!open)}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span class="doc-tree-toggle" aria-hidden="true" />
        )}
        <Link href={`/docs/${encodeURIComponent(doc.key)}`} class="tag-tree-link">
          <Star size={12} class="favorite-star" fill="currentColor" aria-hidden="true" />
          <span class="tag-segment">{doc.title}</span>
          {hasChildren && <span class="count">{node?.total}</span>}
        </Link>
      </div>
      {open && hasChildren && <DocTreeList nodes={children} />}
    </li>
  );
}
