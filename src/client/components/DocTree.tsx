import { useState } from "preact/hooks";
import { Link } from "wouter-preact";
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

function DocTreeList({ nodes }: Props) {
  return (
    <ul class="tag-tree doc-tree">
      {nodes.map((n) => (
        <DocTreeItem key={n.path} node={n} />
      ))}
    </ul>
  );
}

function DocTreeItem({ node }: { node: DocTreeNode }) {
  const [open, setOpen] = useState(false);
  const hasChildren = node.children.length > 0;
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
        {node.key !== undefined ? (
          <Link href={`/docs/${encodeURIComponent(node.key)}`} class="tag-tree-link">
            <span class="tag-segment">{node.segment}</span>
            {hasChildren && <span class="count">{node.total}</span>}
          </Link>
        ) : (
          <button
            type="button"
            class="tag-tree-link doc-tree-branch"
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
