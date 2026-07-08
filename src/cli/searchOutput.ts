import type { SearchHit } from "../core/search/types";

/** Shared search result output (docs: cli-reference.md: key, title, bucket, tags, score, snippet, source) */
export function printHits(hits: SearchHit[], json: boolean): void {
  if (json) {
    console.log(
      JSON.stringify(
        hits.map((h) => ({
          key: h.key,
          title: h.title,
          bucket: h.bucket,
          tags: h.tags,
          score: Number(h.score.toFixed(4)),
          snippet: h.snippet,
          source: h.source,
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (hits.length === 0) {
    console.log("no results");
    return;
  }
  for (const h of hits) {
    const tags = h.tags.length > 0 ? `  ${h.tags.join(",")}` : "";
    console.log(`#${h.key}  ${h.title}  [${h.bucket}]${tags}  (${h.score.toFixed(3)})`);
    if (h.snippet) console.log(`    ${h.snippet.replaceAll("\n", " ")}`);
  }
}
