import type { Database } from "bun:sqlite";
import type { FtsTokenizer } from "../db";
import type { SearchHit } from "./types";

export interface KeywordOptions {
  bucket?: string;
  tag?: string;
  /** AND 検索（`search --all`） */
  all?: boolean;
  limit?: number;
}

/** trigram フォールバック時のクエリ組み立て: 各語をフレーズ化して OR/AND 結合（SPEC §5.4） */
export function buildTrigramQuery(query: string, all: boolean): string {
  const terms = query.split(/\s+/).filter((t) => t !== "");
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(all ? " AND " : " OR ");
}

interface HitRow {
  id: number;
  doc_key: string;
  title: string;
  bucket: string;
  tag_paths: string | null;
  rank_score: number;
  snip: string;
}

function toHit(row: HitRow): SearchHit {
  return {
    docId: row.id,
    key: row.doc_key,
    title: row.title,
    bucket: row.bucket,
    tags: row.tag_paths ? row.tag_paths.split(" ") : [],
    // bm25() は小さいほど良いので符号反転して「大きいほど良い」に揃える
    score: -row.rank_score,
    snippet: row.snip,
    source: "keyword",
  };
}

const TAG_FILTER = `EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
  WHERE dt.document_id = d.id AND (t.path = ? OR t.path LIKE ? || '/%'))`;

const TAGS_SELECT = `(SELECT group_concat(t.path, ' ') FROM document_tags dt
  JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id)`;

/** FTS5 BM25 キーワード検索。title/content/tags を 5.0/1.0/3.0 で重み付け（SPEC §5.4） */
export function keywordSearch(
  db: Database,
  tokenizer: FtsTokenizer,
  rawQuery: string,
  opts: KeywordOptions = {},
): SearchHit[] {
  const query = rawQuery.trim();
  if (query === "") return [];
  const limit = opts.limit ?? 20;

  const matchExpr =
    tokenizer === "vaporetto"
      ? opts.all
        ? "vaporetto_and_query(?)"
        : "vaporetto_or_query(?)"
      : "?";
  const matchParam =
    tokenizer === "vaporetto" ? query : buildTrigramQuery(query, opts.all === true);

  const where: string[] = [`documents_fts MATCH ${matchExpr}`];
  const params: Array<string | number> = [matchParam];
  if (opts.bucket) {
    where.push("b.name = ?");
    params.push(opts.bucket);
  }
  if (opts.tag) {
    where.push(TAG_FILTER);
    params.push(opts.tag, opts.tag);
  }
  params.push(limit);

  const sql = `
    SELECT d.id, d.doc_key, d.title, b.name AS bucket, ${TAGS_SELECT} AS tag_paths,
           bm25(documents_fts, 5.0, 1.0, 3.0) AS rank_score,
           snippet(documents_fts, 1, '**', '**', '…', 20) AS snip
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.rowid
    JOIN buckets b ON b.id = d.bucket_id
    WHERE ${where.join(" AND ")}
    ORDER BY rank_score
    LIMIT ?`;

  let rows: HitRow[];
  try {
    rows = db.prepare(sql).all(...params) as HitRow[];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/no such function: vaporetto|no such tokenizer/.test(message)) {
      throw new Error(
        `FTS クエリに失敗しました（${message}）。vaporetto 拡張が見つかりません。'kura doctor' を実行してください`,
      );
    }
    throw e;
  }

  // trigram は 3 文字未満の語にマッチしないため、ヒット 0 かつ短い語を含む場合は LIKE で代替
  const terms = query.split(/\s+/).filter((t) => t !== "");
  if (rows.length === 0 && tokenizer === "trigram" && terms.some((t) => t.length < 3)) {
    return likeFallback(db, terms, opts, limit);
  }
  return rows.map(toHit);
}

function likeFallback(
  db: Database,
  terms: string[],
  opts: KeywordOptions,
  limit: number,
): SearchHit[] {
  const escaped = terms.map((t) => `%${t.replaceAll(/[\\%_]/g, (c) => `\\${c}`)}%`);
  const joiner = opts.all ? " AND " : " OR ";
  const termClause = escaped
    .map(() => "(d.title LIKE ? ESCAPE '\\' OR d.content LIKE ? ESCAPE '\\')")
    .join(joiner);
  const where: string[] = [`(${termClause})`];
  const params: Array<string | number> = escaped.flatMap((e) => [e, e]);
  if (opts.bucket) {
    where.push("b.name = ?");
    params.push(opts.bucket);
  }
  if (opts.tag) {
    where.push(TAG_FILTER);
    params.push(opts.tag, opts.tag);
  }
  params.push(limit);

  const rows = db
    .prepare(
      `SELECT d.id, d.doc_key, d.title, b.name AS bucket, ${TAGS_SELECT} AS tag_paths, d.content
       FROM documents d JOIN buckets b ON b.id = d.bucket_id
       WHERE ${where.join(" AND ")}
       ORDER BY d.updated_at DESC
       LIMIT ?`,
    )
    .all(...params) as Array<HitRow & { content: string }>;

  return rows.map((row) => {
    const term = terms.find((t) => row.content.includes(t)) ?? terms[0]!;
    const idx = row.content.indexOf(term);
    const start = Math.max(0, idx - 40);
    const end = Math.min(row.content.length, idx + term.length + 40);
    const snippet =
      idx === -1
        ? row.content.slice(0, 80)
        : `${start > 0 ? "…" : ""}${row.content.slice(start, idx)}**${term}**${row.content.slice(idx + term.length, end)}${end < row.content.length ? "…" : ""}`;
    return { ...toHit({ ...row, rank_score: 0, snip: snippet.replaceAll("\n", " ") }) };
  });
}
