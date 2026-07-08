export interface SearchHit {
  docId: number;
  key: string;
  title: string;
  bucket: string;
  tags: string[];
  /** 大きいほど関連が高い（方式ごとに正規化） */
  score: number;
  snippet: string;
  source: "keyword" | "vector" | "hybrid";
}
