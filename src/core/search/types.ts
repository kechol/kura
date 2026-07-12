export interface SearchHit {
  docId: number;
  key: string;
  /** Slash-separated hierarchical namespace; '' = bucket root */
  path: string;
  title: string;
  bucket: string;
  tags: string[];
  /** Higher means more relevant (normalized per method) */
  score: number;
  snippet: string;
  source: "keyword" | "vector" | "hybrid";
}
