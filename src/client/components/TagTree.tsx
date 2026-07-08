import { Link } from "wouter-preact";
import type { TagTreeNode } from "../api";

interface Props {
  nodes: TagTreeNode[];
  /** When true, also show the direct-assignment count (for the tag browser) */
  detail?: boolean;
}

/** Hierarchical tag tree. Clicking filters /docs?tag= */
export function TagTree({ nodes, detail }: Props) {
  if (nodes.length === 0) return <p class="empty">タグはありません</p>;
  return <TagTreeList nodes={nodes} detail={detail} />;
}

function TagTreeList({ nodes, detail }: Props) {
  return (
    <ul class="tag-tree">
      {nodes.map((n) => (
        <li key={n.path}>
          <Link href={`/docs?tag=${encodeURIComponent(n.path)}`} class="tag-tree-link">
            <span class="tag-segment">{n.segment}</span>
            <span class="count">
              {detail && n.count !== n.total ? `${n.count} / ${n.total}` : n.total}
            </span>
          </Link>
          {n.children.length > 0 && <TagTreeList nodes={n.children} detail={detail} />}
        </li>
      ))}
    </ul>
  );
}
