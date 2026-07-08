import type { Database } from "bun:sqlite";
import { requireBucket } from "./buckets";
import { chunkDocument } from "./chunker";
import { ConflictError, NotFoundError, UsageError } from "./errors";
import type { Frontmatter } from "./frontmatter";
import { ftsDelete, ftsUpsert } from "./fts";
import { getOrCreateBucket } from "./buckets";
import { resolveUnresolvedLinks, syncLinks } from "./links";
import { addTagsToDoc, docTags } from "./tags";
import { extractWiki, replaceWikiLinkTarget } from "./wiki";

export type ContentType = "markdown" | "html";

export interface DocumentRecord {
  id: number;
  key: string;
  bucketId: number;
  bucket: string;
  title: string;
  content: string;
  contentType: ContentType;
  sourceUrl: string | null;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  tags: string[];
}

interface DocRow {
  id: number;
  doc_key: string;
  bucket_id: number;
  bucket: string;
  title: string;
  content: string;
  content_type: string;
  source_url: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
}

const SELECT_DOC = `
  SELECT d.id, d.doc_key, d.bucket_id, b.name AS bucket, d.title, d.content,
         d.content_type, d.source_url, d.content_hash, d.created_at, d.updated_at,
         d.last_accessed_at, d.access_count
  FROM documents d JOIN buckets b ON b.id = d.bucket_id`;

function toRecord(db: Database, row: DocRow): DocumentRecord {
  return {
    id: row.id,
    key: row.doc_key,
    bucketId: row.bucket_id,
    bucket: row.bucket,
    title: row.title,
    content: row.content,
    contentType: row.content_type === "html" ? "html" : "markdown",
    sourceUrl: row.source_url,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    tags: docTags(db, row.id),
  };
}

export function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

const DOC_KEY_RE = /^[0-9a-f]{8}$/;

/** 8文字の短縮 ID（内容+乱数の hash、SPEC §3.1） */
function generateDocKey(db: Database, seed: string): string {
  for (;;) {
    const random = crypto.getRandomValues(new Uint32Array(2)).join("-");
    const key = sha256Hex(`${seed}:${random}`).slice(0, 8);
    const exists = db.prepare("SELECT 1 FROM documents WHERE doc_key = ?").get(key);
    if (!exists) return key;
  }
}

/** チャンクを再生成する（embedding は遅延バックフィル: embedded_at = NULL、SPEC §5.3） */
function rebuildChunks(db: Database, docId: number, title: string, content: string): void {
  db.prepare(
    "DELETE FROM chunks_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
  ).run(docId);
  db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
  const insert = db.prepare(
    "INSERT INTO chunks (document_id, seq, text, start_offset) VALUES (?, ?, ?, ?)",
  );
  for (const chunk of chunkDocument(content, title)) {
    insert.run(docId, chunk.seq, chunk.text, chunk.startOffset);
  }
}

interface SyncOptions {
  tags?: string[];
  tagSource?: "manual" | "auto";
  rebuildChunks: boolean;
  resolveIncoming: boolean;
}

/** 保存トランザクション内で FTS / links / tags / chunks を同期する（SPEC §3.2） */
function syncDerived(db: Database, row: DocRow, opts: SyncOptions): void {
  const extraction =
    row.content_type === "html" ? { links: [], tags: [] } : extractWiki(row.content);
  const tags = [...(opts.tags ?? []), ...extraction.tags];
  if (tags.length > 0) addTagsToDoc(db, row.id, tags, opts.tagSource ?? "manual");
  syncLinks(db, row.id, row.bucket_id, extraction.links);
  ftsUpsert(db, { id: row.id, title: row.title, content: row.content });
  if (opts.rebuildChunks) rebuildChunks(db, row.id, row.title, row.content);
  if (opts.resolveIncoming) resolveUnresolvedLinks(db, row.bucket_id, row.title, row.id);
}

function getRowById(db: Database, id: number): DocRow {
  const row = db.prepare(`${SELECT_DOC} WHERE d.id = ?`).get(id) as DocRow | null;
  if (!row) throw new NotFoundError(`document not found: id=${id}`);
  return row;
}

export interface CreateDocumentInput {
  title: string;
  content: string;
  bucket: string;
  contentType?: ContentType;
  sourceUrl?: string | null;
  tags?: string[];
  tagSource?: "manual" | "auto";
  /** import ラウンドトリップ用（未使用なら採番） */
  docKey?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function createDocument(db: Database, input: CreateDocumentInput): DocumentRecord {
  return db.transaction(() => {
    const title = input.title.trim();
    if (title === "") throw new UsageError("document title must not be empty");
    const bucket = requireBucket(db, input.bucket);

    const dup = db
      .prepare("SELECT doc_key FROM documents WHERE bucket_id = ? AND lower(title) = lower(?)")
      .get(bucket.id, title) as { doc_key: string } | null;
    if (dup) {
      throw new ConflictError(
        `document '${title}' already exists in bucket '${bucket.name}' (#${dup.doc_key})`,
      );
    }

    let key = input.docKey;
    if (key !== undefined) {
      if (!DOC_KEY_RE.test(key)) throw new UsageError(`invalid doc key: ${key}`);
      if (db.prepare("SELECT 1 FROM documents WHERE doc_key = ?").get(key)) {
        key = undefined;
      }
    }
    key ??= generateDocKey(db, `${title}:${input.content}`);

    const now = new Date();
    const created = input.createdAt ?? sqliteNow(now);
    const updated = input.updatedAt ?? created;
    const result = db
      .prepare(
        `INSERT INTO documents
           (doc_key, bucket_id, title, content, content_type, source_url, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        bucket.id,
        title,
        input.content,
        input.contentType ?? "markdown",
        input.sourceUrl ?? null,
        sha256Hex(input.content),
        created,
        updated,
      );

    const row = getRowById(db, Number(result.lastInsertRowid));
    syncDerived(db, row, {
      tags: input.tags,
      tagSource: input.tagSource,
      rebuildChunks: true,
      resolveIncoming: true,
    });
    return toRecord(db, row);
  })();
}

export interface UpdateDocumentInput {
  title?: string;
  content?: string;
  bucket?: string;
  contentType?: ContentType;
  sourceUrl?: string | null;
  tags?: string[];
  tagSource?: "manual" | "auto";
  updatedAt?: string;
}

export interface UpdateResult {
  record: DocumentRecord;
  /** リネームで本文を書き換えた被リンク元ドキュメント数 */
  relinked: number;
}

export function updateDocument(db: Database, id: number, input: UpdateDocumentInput): UpdateResult {
  return db.transaction(() => {
    const row = getRowById(db, id);
    const oldTitle = row.title;
    const newTitle = input.title?.trim() ?? oldTitle;
    if (newTitle === "") throw new UsageError("document title must not be empty");
    const newBucket = input.bucket ? requireBucket(db, input.bucket) : null;
    const newBucketId = newBucket?.id ?? row.bucket_id;

    let content = input.content ?? row.content;
    const titleChanged = newTitle !== oldTitle;
    const bucketChanged = newBucketId !== row.bucket_id;

    // 自分の本文中の自己リンクも張り替える
    if (titleChanged && row.content_type !== "html") {
      content = replaceWikiLinkTarget(content, oldTitle, newTitle);
    }
    const newHash = sha256Hex(content);
    const contentChanged = newHash !== row.content_hash;

    if (titleChanged || bucketChanged) {
      const dup = db
        .prepare(
          "SELECT doc_key FROM documents WHERE bucket_id = ? AND lower(title) = lower(?) AND id != ?",
        )
        .get(newBucketId, newTitle, id) as { doc_key: string } | null;
      if (dup) {
        throw new ConflictError(
          `document '${newTitle}' already exists in bucket (#${dup.doc_key})`,
        );
      }
    }

    db.prepare(
      `UPDATE documents SET title = ?, content = ?, content_type = ?, source_url = ?,
         content_hash = ?, bucket_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      newTitle,
      content,
      input.contentType ?? row.content_type,
      input.sourceUrl === undefined ? row.source_url : input.sourceUrl,
      newHash,
      newBucketId,
      input.updatedAt ?? sqliteNow(new Date()),
      id,
    );

    if (bucketChanged) {
      // リンク解決は Bucket 内スコープのため、旧 Bucket からの被リンクは未解決に戻す
      db.prepare("UPDATE links SET target_id = NULL WHERE target_id = ?").run(id);
    }

    // 被リンク元の [[旧タイトル]] を張り替え（同一 Bucket 内、kura mv 挙動）
    let relinked = 0;
    if (titleChanged && !bucketChanged) {
      const referrers = db
        .prepare("SELECT DISTINCT source_id FROM links WHERE target_id = ? AND source_id != ?")
        .all(id, id) as Array<{ source_id: number }>;
      for (const ref of referrers) {
        const src = getRowById(db, ref.source_id);
        if (src.content_type === "html") continue;
        const rewritten = replaceWikiLinkTarget(src.content, oldTitle, newTitle);
        if (rewritten !== src.content) {
          updateDocument(db, src.id, { content: rewritten });
          relinked++;
        }
      }
    }

    const updatedRow = getRowById(db, id);
    syncDerived(db, updatedRow, {
      tags: input.tags,
      tagSource: input.tagSource,
      // チャンクのコンテキストヘッダにタイトルを含むためリネーム時も再構築
      rebuildChunks: contentChanged || titleChanged,
      resolveIncoming: titleChanged || bucketChanged,
    });
    return { record: toRecord(db, updatedRow), relinked };
  })();
}

/** kura mv: リネーム + 被リンク元の [[旧タイトル]] 張り替え */
export function renameDocument(db: Database, id: number, newTitle: string): UpdateResult {
  return updateDocument(db, id, { title: newTitle });
}

export function deleteDocument(db: Database, id: number): void {
  db.transaction(() => {
    getRowById(db, id);
    db.prepare(
      "DELETE FROM chunks_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
    ).run(id);
    ftsDelete(db, id);
    // chunks / document_tags / links(source) は CASCADE、被リンクは SET NULL で未解決に戻る
    db.prepare("DELETE FROM documents WHERE id = ?").run(id);
  })();
}

export function getDocumentByKey(db: Database, key: string): DocumentRecord | null {
  const row = db.prepare(`${SELECT_DOC} WHERE d.doc_key = ?`).get(key) as DocRow | null;
  return row ? toRecord(db, row) : null;
}

export function getDocumentById(db: Database, id: number): DocumentRecord {
  return toRecord(db, getRowById(db, id));
}

/**
 * ドキュメント指定子の解決（SPEC §7）: doc_key / #key / Bucket 内で一意なタイトル。
 * タイトルが複数 Bucket で一致する場合は候補を示して ConflictError。
 */
export function resolveDoc(db: Database, spec: string, bucketName?: string): DocumentRecord {
  const trimmed = spec.trim();
  const explicitKey = trimmed.startsWith("#");
  const keyCandidate = explicitKey ? trimmed.slice(1) : trimmed;

  if (DOC_KEY_RE.test(keyCandidate)) {
    const byKey = getDocumentByKey(db, keyCandidate);
    if (byKey) return byKey;
    if (explicitKey) throw new NotFoundError(`document not found: #${keyCandidate}`);
  } else if (explicitKey) {
    throw new UsageError(`invalid doc key: ${trimmed}`);
  }

  const rows = (
    bucketName
      ? db
          .prepare(`${SELECT_DOC} WHERE lower(d.title) = lower(?) AND b.name = ?`)
          .all(trimmed, bucketName)
      : db.prepare(`${SELECT_DOC} WHERE lower(d.title) = lower(?)`).all(trimmed)
  ) as DocRow[];

  if (rows.length === 0) throw new NotFoundError(`document not found: ${trimmed}`);
  if (rows.length > 1) {
    const candidates = rows.map((r) => `#${r.doc_key} (${r.bucket})`).join(", ");
    throw new ConflictError(
      `title '${trimmed}' is ambiguous across buckets: ${candidates}. Use #key or --bucket`,
    );
  }
  return toRecord(db, rows[0]!);
}

/** get / MCP get / 検索結果本文取得での参照記録（SPEC §3.1） */
export function touchAccess(db: Database, id: number): void {
  db.prepare(
    "UPDATE documents SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?",
  ).run(id);
}

export interface ListFilter {
  bucket?: string;
  /** タグ（子孫タグも含む） */
  tag?: string;
  sort?: "updated" | "created" | "accessed" | "title";
  stale?: boolean;
  staleDays?: number;
  limit?: number;
  offset?: number;
}

const SORT_SQL: Record<NonNullable<ListFilter["sort"]>, string> = {
  updated: "d.updated_at DESC",
  created: "d.created_at DESC",
  accessed: "d.last_accessed_at IS NULL, d.last_accessed_at DESC",
  title: "d.title COLLATE NOCASE ASC",
};

export function listDocuments(db: Database, filter: ListFilter = {}): DocumentRecord[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.bucket) {
    where.push("b.name = ?");
    params.push(filter.bucket);
  }
  if (filter.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id = dt.tag_id
        WHERE dt.document_id = d.id AND (t.path = ? OR t.path LIKE ? || '/%'))`,
    );
    params.push(filter.tag, filter.tag);
  }
  if (filter.stale) {
    where.push("d.updated_at < datetime('now', ?)");
    params.push(`-${filter.staleDays ?? 180} days`);
  }
  const sort = filter.stale ? "d.updated_at ASC" : SORT_SQL[filter.sort ?? "updated"];
  let sql = `${SELECT_DOC}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY ${sort}`;
  if (filter.limit !== undefined) {
    sql += " LIMIT ?";
    params.push(filter.limit);
    if (filter.offset !== undefined) {
      sql += " OFFSET ?";
      params.push(filter.offset);
    }
  }
  const rows = db.prepare(sql).all(...params) as DocRow[];
  return rows.map((r) => toRecord(db, r));
}

function sqliteNow(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export interface ImportInput {
  fm: Frontmatter | null;
  body: string;
  /** frontmatter に title がないときのフォールバック（ファイル名など） */
  fallbackTitle: string;
  /** --bucket 指定（frontmatter より優先） */
  bucketOverride?: string;
  defaultBucket: string;
}

export interface ImportResult {
  record: DocumentRecord;
  action: "created" | "updated";
}

/** frontmatter 付き Markdown の取り込み。kura_key が既存なら更新、無ければ新規（SPEC §7.2） */
export function importDocument(db: Database, input: ImportInput): ImportResult {
  return db.transaction(() => {
    const fm = input.fm;
    const bucketName = input.bucketOverride ?? fm?.bucket ?? input.defaultBucket;
    getOrCreateBucket(db, bucketName);
    const title = fm?.title ?? input.fallbackTitle;

    const existing = fm?.kura_key ? getDocumentByKey(db, fm.kura_key) : null;
    if (existing) {
      const { record } = updateDocument(db, existing.id, {
        title,
        content: input.body,
        bucket: bucketName,
        contentType: fm?.content_type,
        sourceUrl: fm?.source_url ?? existing.sourceUrl,
        tags: fm?.tags,
        updatedAt: fm?.updated_at,
      });
      return { record, action: "updated" as const };
    }

    const record = createDocument(db, {
      title,
      content: input.body,
      bucket: bucketName,
      contentType: fm?.content_type,
      sourceUrl: fm?.source_url ?? null,
      tags: fm?.tags,
      docKey: fm?.kura_key,
      createdAt: fm?.created_at,
      updatedAt: fm?.updated_at,
    });
    return { record, action: "created" as const };
  })();
}
