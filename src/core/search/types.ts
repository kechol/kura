export interface SearchHit {
  docId: number;
  key: string;
  title: string;
  bucket: string;
  tags: string[];
  /** Higher means more relevant (normalized per method) */
  score: number;
  snippet: string;
  source: "keyword" | "vector" | "hybrid";
}
