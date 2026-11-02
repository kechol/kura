import { useState } from "preact/hooks";
import { Link, useLocation } from "wouter-preact";
import type { DocTreeNode } from "../api";

interface Props {
  nodes: DocTreeNode[];
}

/**
 * Collapsible document-path tree for the sidebar. Branch nodes toggle;
 * document nodes link to the detail page. A branch that is itself a
 * document (node.key set alongside children) does both.
 */
export function DocTree({ nodes }: Props) {
  if (nodes.length === 0) return <p class="empty">ドキュメントはありません</p>;
  return <DocTreeList nodes={nodes} />;
}

export function DocTreeList({ nodes }: Props) {
  return (
    <ul class="tag-tree doc-tree">
      {nodes.map((n) => (
        <DocTreeItem key={n.path} node={n} />
      ))}
    </ul>
  );
}

function DocTreeItem({ node }: { node: DocTreeNode }) {
  const [location] = useLocation();
  const [open, setOpen] = useState(false);
  const hasChildren = node.children.length > 0;
  const href = node.key === undefined ? null : `/docs/${encodeURIComponent(node.key)}`;
  const toggleLabel = `${node.segment} を${open ? "折りたたむ" : "展開する"}`;
  return (
    <li>
      <div class="doc-tree-row">
        {hasChildren ? (
          <button
            type="button"
            class="doc-tree-toggle"
            aria-expanded={open}
            aria-label={toggleLabel}
            // A branch without a document is toggled by its whole row: one tab stop is enough
            tabIndex={href === null ? -1 : undefined}
            onClick={() => setOpen(!open)}
          >
            {open ? "▾" : "▸"}
          </button>
        ) : (
          <span class="doc-tree-toggle" aria-hidden="true" />
        )}
        {href !== null ? (
          <Link
            href={href}
            class="tag-tree-link"
            aria-current={location === href ? "page" : undefined}
          >
            <span class="tag-segment">{node.segment}</span>
            {hasChildren && <span class="count">{node.total}</span>}
          </Link>
        ) : (
          <button
            type="button"
            class="tag-tree-link doc-tree-branch"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span class="tag-segment">{node.segment}</span>
            <span class="count">{node.total}</span>
          </button>
        )}
      </div>
      {open && hasChildren && <DocTreeList nodes={node.children} />}
    </li>
  );
}
