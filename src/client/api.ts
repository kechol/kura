/** REST API client (mirrors the response shapes of src/server/api.ts) */

export interface Stats {
  documents: number;
  buckets: Array<{ name: string; documents: number }>;
  tags: number;
  chunks: number;
  embeddedChunks: number;
  embeddingCoverage: number;
  staleDocuments: number;
  unresolvedLinks: number;
  dbSizeBytes: number;
  tokenizer: string;
  embeddingModel: string | null;
}

export interface Bucket {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
  documents: number;
}

export interface InsightDoc {
  key: string;
  title: string;
  path?: string;
}

export interface InsightGroup {
  count: number;
  docs: InsightDoc[];
}

export interface TagDuplicate {
  from: string;
  to: string;
  reason: string;
  similarity: number;
}

export interface Insights {
  orphans: InsightGroup;
  untagged: InsightGroup;
  unfiled: InsightGroup;
  brokenLinks: { count: number; links: Array<{ targetTitle: string; sources: InsightDoc[] }> };
  tagDuplicates: TagDuplicate[];
}

export interface DocMeta {
  key: string;
  path: string;
  title: string;
  bucket: string;
  tags: string[];
  aliases: string[];
  content_type: string;
  source_url: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  favorite: boolean;
  /** Plain-text body preview (≤200 chars); present only when the list query opts in with excerpt=1 */
  excerpt?: string;
}

export interface DocDetail extends DocMeta {
  content: string;
}

export interface DocListResult {
  docs: DocMeta[];
  total: number;
  page: number;
  per: number;
}

export interface RelatedDoc {
  key: string;
  title: string;
  bucket: string;
}

export interface Outlink {
  target_title: string;
  target: RelatedDoc | null;
}

export interface TwoHopGroup {
  via: RelatedDoc;
  docs: RelatedDoc[];
}

export interface Related {
  outlinks: Outlink[];
  backlinks: RelatedDoc[];
  twoHop: TwoHopGroup[];
}

export type SearchMode = "keyword" | "vector" | "hybrid";

export interface SearchHit {
  key: string;
  path: string;
  title: string;
  bucket: string;
  tags: string[];
  score: number;
  snippet: string;
  source: SearchMode;
}

export interface SearchResult {
  hits: SearchHit[];
  warnings: string[];
}

export interface TagEntry {
  path: string;
  count: number;
}

export interface TagTreeNode {
  segment: string;
  path: string;
  count: number;
  total: number;
  children: TagTreeNode[];
}

export interface DocTreeNode {
  segment: string;
  path: string;
  /** Present when this node is a document (a branch can also be one) */
  key?: string;
  total: number;
  children: DocTreeNode[];
}

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

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(body?.error ?? `HTTP ${res.status}`, res.status);
  return body as T;
}

function qs(params: Record<string, string | number | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s === "" ? "" : `?${s}`;
}

export function fetchStats(): Promise<Stats> {
  return request<Stats>("/api/stats");
}

export function fetchBuckets(): Promise<Bucket[]> {
  return request<Bucket[]>("/api/buckets");
}

/** Tidying insights for one bucket: orphans, untagged, unfiled, broken links, duplicate tags */
export function fetchInsights(bucket: string): Promise<Insights> {
  return request<Insights>(`/api/insights${qs({ bucket })}`);
}

/** One staleness candidate — camelCase like insights/stats. Carries `path` so DocTitle can prefix it. */
export interface StaleDoc {
  key: string;
  path: string;
  title: string;
  bucket: string;
  daysSinceUpdate: number;
  accessCount: number;
  backlinkCount: number;
  staleScore: number;
}

export interface StaleResult {
  count: number;
  staleDays: number;
  docs: StaleDoc[];
}

/** Scored staleness candidates for one bucket, most stale first (GET /api/stale) */
export function fetchStale(bucket: string, limit?: number): Promise<StaleResult> {
  return request<StaleResult>(`/api/stale${qs({ bucket, limit })}`);
}

export interface DocsQuery {
  bucket?: string;
  tag?: string;
  prefix?: string;
  favorite?: boolean;
  sort?: string;
  stale?: boolean;
  /** Ask the server to attach a plain-text `excerpt` to every doc (excerpt=1) */
  excerpt?: boolean;
  page?: number;
  per?: number;
}

export function fetchDocs(q: DocsQuery = {}): Promise<DocListResult> {
  return request<DocListResult>(
    `/api/docs${qs({
      bucket: q.bucket,
      tag: q.tag,
      prefix: q.prefix,
      favorite: q.favorite ? "1" : undefined,
      sort: q.sort,
      stale: q.stale ? "1" : undefined,
      excerpt: q.excerpt ? "1" : undefined,
      page: q.page,
      per: q.per,
    })}`,
  );
}

/** Favorites of one bucket, alphabetical — the sidebar pins these on every screen */
export async function fetchFavorites(bucket: string): Promise<DocMeta[]> {
  const res = await fetchDocs({ bucket, favorite: true, sort: "title", per: 200 });
  return res.docs;
}

/**
 * Reading history: the documents most recently opened, newest first. "Recent" means
 * `last_accessed_at`, which `touchAccess()` bumps on every read — including reads from the
 * CLI and MCP — and documents never opened are left out rather than padding the list.
 */
export async function fetchRecentDocs(
  bucket: string,
  opts: { limit: number; tag?: string } = { limit: 20 },
): Promise<DocMeta[]> {
  const res = await fetchDocs({ bucket, tag: opts.tag, sort: "accessed", per: opts.limit });
  return res.docs.filter((d) => d.last_accessed_at !== null);
}

export function fetchDoc(key: string): Promise<DocDetail> {
  return request<DocDetail>(`/api/docs/${encodeURIComponent(key)}`);
}

/** Create a document. A colliding title retries as "title (2)" server-side. */
export function createDoc(body: {
  title: string;
  bucket: string;
  content?: string;
  path?: string;
  tags?: string[];
}): Promise<DocDetail> {
  return request<DocDetail>("/api/docs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Resolve a doc specifier (key / full path / unique title) via GET /api/resolve */
export function resolveDocSpec(spec: string, bucket?: string): Promise<DocMeta> {
  return request<DocMeta>(`/api/resolve${qs({ doc: spec, bucket })}`);
}

export function updateDoc(
  key: string,
  body: { title?: string; path?: string; content?: string; tags?: string[]; aliases?: string[] },
): Promise<DocDetail> {
  return request<DocDetail>(`/api/docs/${encodeURIComponent(key)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Pin / unpin. Its own endpoint because starring must not bump updated_at */
export function setFavorite(key: string, favorite: boolean): Promise<DocMeta> {
  return request<DocMeta>(`/api/docs/${encodeURIComponent(key)}/favorite`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ favorite }),
  });
}

export function deleteDoc(key: string): Promise<{ deleted: string }> {
  return request<{ deleted: string }>(`/api/docs/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

export function fetchRelated(key: string): Promise<Related> {
  return request<Related>(`/api/docs/${encodeURIComponent(key)}/related`);
}

export interface SearchQuery {
  q: string;
  mode?: SearchMode;
  bucket?: string;
  tag?: string;
  limit?: number;
}

export function searchDocs(p: SearchQuery): Promise<SearchResult> {
  return request<SearchResult>(
    `/api/search${qs({ q: p.q, mode: p.mode, bucket: p.bucket, tag: p.tag, limit: p.limit })}`,
  );
}

/** Tag tree, optionally counted within a single bucket (tags it does not use drop out) */
export function fetchTagTree(bucket?: string): Promise<TagTreeNode[]> {
  return request<TagTreeNode[]>(`/api/tags${qs({ tree: "1", bucket })}`);
}

/** Flat tag list (path + count), for the search modal's tag tab */
export function fetchTags(bucket?: string): Promise<TagEntry[]> {
  return request<TagEntry[]>(`/api/tags${qs({ bucket })}`);
}

export function fetchDocTree(bucket: string): Promise<DocTreeNode[]> {
  return request<DocTreeNode[]>(`/api/docs/tree${qs({ bucket })}`);
}

export function fetchGraph(q: { bucket?: string; tag?: string } = {}): Promise<GraphData> {
  return request<GraphData>(`/api/graph${qs({ bucket: q.bucket, tag: q.tag })}`);
}
