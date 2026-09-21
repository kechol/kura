import type { Database } from "bun:sqlite";
import { hierarchyParameters, hierarchyPredicate } from "./hierarchy";

export interface GraphNode {
  key: string;
  title: string;
  tags: string[];
  degree: number;
  stale: boolean;
}

export interface GraphEdge {
  source: string;
  target: string;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface GraphFilter {
  bucket?: string;
  tag?: string;
}

interface GraphDocRow {
  id: number;
  key: string;
  title: string;
  updated_at: string;
}

function selection(filter: GraphFilter): { sql: string; params: string[] } {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.bucket) {
    where.push("b.name = ?");
    params.push(filter.bucket);
  }
  if (filter.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM document_tags fdt JOIN tags ft ON ft.id = fdt.tag_id
        WHERE fdt.document_id = d.id AND ${hierarchyPredicate("ft.path")})`,
    );
    params.push(...hierarchyParameters(filter.tag));
  }
  return {
    sql: `SELECT d.id, d.doc_key AS key, d.title, d.updated_at
      FROM documents d JOIN buckets b ON b.id = d.bucket_id
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}`,
    params,
  };
}

/**
 * Graph-only read path. It deliberately omits document bodies and aliases, scopes links in
 * SQL, and joins tags without constructing a bind parameter for every selected document.
 */
export function readGraph(db: Database, staleDays: number, filter: GraphFilter = {}): GraphData {
  const selected = selection(filter);
  const docs = db
    .prepare(`${selected.sql} ORDER BY d.updated_at DESC`)
    .all(...selected.params) as GraphDocRow[];

  const tagsById = new Map<number, string[]>();
  const tagRows = db
    .prepare(
      `WITH selected AS (${selected.sql})
       SELECT dt.document_id, t.path
       FROM selected s
       JOIN document_tags dt ON dt.document_id = s.id
       JOIN tags t ON t.id = dt.tag_id
       ORDER BY dt.document_id, t.path`,
    )
    .all(...selected.params) as Array<{ document_id: number; path: string }>;
  for (const row of tagRows) {
    const tags = tagsById.get(row.document_id);
    if (tags) tags.push(row.path);
    else tagsById.set(row.document_id, [row.path]);
  }

  const edgeRows = db
    .prepare(
      `WITH selected AS (${selected.sql})
       SELECT source.key AS source, target.key AS target
       FROM links l
       JOIN selected source ON source.id = l.source_id
       JOIN selected target ON target.id = l.target_id
       WHERE l.target_id IS NOT NULL`,
    )
    .all(...selected.params) as GraphEdge[];
  const degree = new Map<string, number>();
  for (const edge of edgeRows) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  // Accepted safe integers can exceed Date's representable range. Comparing epochs
  // avoids throwing while retaining the previous cutoff's whole-second precision.
  const cutoff = Math.floor((Date.now() - staleDays * 86_400_000) / 1000) * 1000;
  return {
    nodes: docs.map((doc) => ({
      key: doc.key,
      title: doc.title,
      tags: tagsById.get(doc.id) ?? [],
      degree: degree.get(doc.key) ?? 0,
      stale: Date.parse(`${doc.updated_at.replace(" ", "T")}Z`) < cutoff,
    })),
    edges: edgeRows,
  };
}
