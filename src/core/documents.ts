import type { Database } from "bun:sqlite";
import { addAliasesToDoc, docAliases, docAliasesBatch } from "./aliases";
import { getOrCreateBucket, requireBucket } from "./buckets";
import { chunkDocument } from "./chunker";
import { ConflictError, NotFoundError, UsageError } from "./errors";
import type { Frontmatter } from "./frontmatter";
import { ftsDelete, ftsUpsert } from "./fts";
import { fullPathSql, resolveUnresolvedLinks, syncLinks } from "./links";
import { snapshotRevision } from "./revisions";
import { addTagsToDoc, docTags, docTagsBatch } from "./tags";
import {
  extractWiki,
  joinDocPath,
  normalizeDocPath,
  replaceWikiLinkTargets,
  type WikiLinkReplacement,
} from "./wiki";

export type ContentType = "markdown" | "html";

export interface DocumentRecord {
  id: number;
  key: string;
  bucketId: number;
  bucket: string;
  /** Slash-separated hierarchical namespace; '' = bucket root (docs: document-notation.md) */
  path: string;
  title: string;
  content: string;
  contentType: ContentType;
  sourceUrl: string | null;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt: string | null;
  accessCount: number;
  /** Pinned to the browser sidebar (docs: browser-ui.md) */
  favorite: boolean;
  /** ISO-8601 of the last triage pass; null = never triaged (docs: self-healing.md) */
  triagedAt: string | null;
  tags: string[];
  /** Alternate titles for link resolution and search (docs: document-notation.md) */
  aliases: string[];
}

interface DocRow {
  id: number;
  doc_key: string;
  bucket_id: number;
  bucket: string;
  path: string;
  title: string;
  content: string;
  content_type: string;
  source_url: string | null;
  content_hash: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
  access_count: number;
  favorite: number;
  triaged_at: string | null;
}

const SELECT_DOC = `
  SELECT d.id, d.doc_key, d.bucket_id, b.name AS bucket, d.path, d.title, d.content,
         d.content_type, d.source_url, d.content_hash, d.created_at, d.updated_at,
         d.last_accessed_at, d.access_count, d.favorite, d.triaged_at
  FROM documents d JOIN buckets b ON b.id = d.bucket_id`;

/** preloaded lets list paths batch-fetch tags/aliases instead of two queries per row */
function toRecord(
  db: Database,
  row: DocRow,
  preloaded?: { tags: string[]; aliases: string[] },
): DocumentRecord {
  return {
    id: row.id,
    key: row.doc_key,
    bucketId: row.bucket_id,
    bucket: row.bucket,
    path: row.path,
    title: row.title,
    content: row.content,
    contentType: row.content_type === "html" ? "html" : "markdown",
    sourceUrl: row.source_url,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at,
    accessCount: row.access_count,
    favorite: row.favorite === 1,
    triagedAt: row.triaged_at,
    tags: preloaded?.tags ?? docTags(db, row.id),
    aliases: preloaded?.aliases ?? docAliases(db, row.id),
  };
}

export function sha256Hex(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

const DOC_KEY_RE = /^[0-9a-f]{8}$/;

/** 8-character short ID (hash of content plus randomness, docs: data-model.md) */
function generateDocKey(db: Database, seed: string): string {
  for (;;) {
    const random = crypto.getRandomValues(new Uint32Array(2)).join("-");
    const key = sha256Hex(`${seed}:${random}`).slice(0, 8);
    const exists = db.prepare("SELECT 1 FROM documents WHERE doc_key = ?").get(key);
    if (!exists) return key;
  }
}

/** Rebuild chunks (embeddings are backfilled lazily: embedded_at = NULL, docs: search-pipeline.md) */
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

/** Sync FTS / links / tags / chunks inside the save transaction (docs: data-model.md) */
function syncDerived(db: Database, row: DocRow, opts: SyncOptions): void {
  const extraction =
    row.content_type === "html" ? { links: [], tags: [] } : extractWiki(row.content);
  const tags = [...(opts.tags ?? []), ...extraction.tags];
  if (tags.length > 0) addTagsToDoc(db, row.id, tags, opts.tagSource ?? "manual");
  syncLinks(db, row.id, row.bucket_id, extraction.links);
  ftsUpsert(db, { id: row.id, title: row.title, content: row.content });
  if (opts.rebuildChunks) rebuildChunks(db, row.id, row.title, row.content);
  if (opts.resolveIncoming) resolveUnresolvedLinks(db, row.bucket_id, row.id, row.path, row.title);
}

function getRowById(db: Database, id: number): DocRow {
  const row = db.prepare(`${SELECT_DOC} WHERE d.id = ?`).get(id) as DocRow | null;
  if (!row) throw new NotFoundError(`document not found: id=${id}`);
  return row;
}

/**
 * Case-insensitive uniqueness of the computed full path within a bucket
 * (docs: data-model.md). Subsumes (path, title) equality and also rejects
 * cross-form collisions like path='a',title='b/c' vs path='a/b',title='c',
 * which would make full-path references ambiguous. The DB constraint
 * UNIQUE(bucket_id, path, title) remains as the case-sensitive backstop.
 */
function assertUniqueInBucket(
  db: Database,
  bucketId: number,
  path: string,
  title: string,
  excludeId = -1,
): void {
  const full = joinDocPath(path, title);
  const dup = db
    .prepare(
      `SELECT doc_key, path, title FROM documents
       WHERE bucket_id = ? AND id != ? AND lower(${fullPathSql()}) = lower(?)`,
    )
    .get(bucketId, excludeId, full) as { doc_key: string; path: string; title: string } | null;
  if (!dup) return;
  if (dup.path.toLowerCase() === path.toLowerCase()) {
    throw new ConflictError(`document '${full}' already exists in bucket (#${dup.doc_key})`);
  }
  throw new ConflictError(
    `full path '${full}' collides with '${joinDocPath(dup.path, dup.title)}' (#${dup.doc_key}) in the same bucket`,
  );
}

export interface CreateDocumentInput {
  title: string;
  content: string;
  bucket: string;
  /** Slash-separated hierarchical namespace; omit or '' for the bucket root */
  path?: string;
  contentType?: ContentType;
  sourceUrl?: string | null;
  tags?: string[];
  tagSource?: "manual" | "auto";
  aliases?: string[];
  /** For import round-trips (a new key is generated when unused) */
  docKey?: string;
  createdAt?: string;
  updatedAt?: string;
}

export function createDocument(db: Database, input: CreateDocumentInput): DocumentRecord {
  return db.transaction(() => {
    const title = input.title.trim();
    if (title === "") throw new UsageError("document title must not be empty");
    const path = normalizeDocPath(input.path ?? "");
    const bucket = requireBucket(db, input.bucket);
    assertUniqueInBucket(db, bucket.id, path, title);

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
           (doc_key, bucket_id, path, title, content, content_type, source_url, content_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        bucket.id,
        path,
        title,
        input.content,
        input.contentType ?? "markdown",
        input.sourceUrl ?? null,
        sha256Hex(input.content),
        created,
        updated,
      );

    const row = getRowById(db, Number(result.lastInsertRowid));
    // Aliases go in before syncDerived: ftsUpsert composes the aliases column
    // and resolveIncoming self-heals [[alias]] links written before this doc
    if (input.aliases !== undefined && input.aliases.length > 0) {
      addAliasesToDoc(db, row.id, input.aliases);
    }
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
  /** Slash-separated hierarchical namespace; '' moves the document to the bucket root */
  path?: string;
  contentType?: ContentType;
  sourceUrl?: string | null;
  tags?: string[];
  tagSource?: "manual" | "auto";
  /** Add-only, like tags (removal goes through removeAliasesFromDoc / setAliasesForDoc) */
  aliases?: string[];
  updatedAt?: string;
}

export interface UpdateResult {
  record: DocumentRecord;
  /** Number of referring documents whose bodies were rewritten by the rename */
  relinked: number;
}

export function updateDocument(db: Database, id: number, input: UpdateDocumentInput): UpdateResult {
  return db.transaction(() => {
    const row = getRowById(db, id);
    const oldTitle = row.title;
    const newTitle = input.title?.trim() ?? oldTitle;
    if (newTitle === "") throw new UsageError("document title must not be empty");
    const newPath = input.path !== undefined ? normalizeDocPath(input.path) : row.path;
    const newBucket = input.bucket ? requireBucket(db, input.bucket) : null;
    const newBucketId = newBucket?.id ?? row.bucket_id;

    let content = input.content ?? row.content;
    const titleChanged = newTitle !== oldTitle;
    const pathChanged = newPath !== row.path;
    const bucketChanged = newBucketId !== row.bucket_id;

    if (titleChanged || pathChanged || bucketChanged) {
      assertUniqueInBucket(db, newBucketId, newPath, newTitle, id);
    }

    // Rewrite matrix for referrer bodies (docs: document-notation.md):
    //   title change     -> both the short title and the full-path spelling
    //   path-only move   -> the full-path spelling only (short links stay valid)
    //   bucket move      -> nothing; incoming links become unresolved below
    const replacements: WikiLinkReplacement[] = [];
    if (!bucketChanged && (titleChanged || pathChanged)) {
      const oldFull = joinDocPath(row.path, oldTitle);
      const newFull = joinDocPath(newPath, newTitle);
      if (titleChanged) {
        // Point short-form links at the full path when the new title alone
        // would be ambiguous in the bucket, so they keep resolving
        const titleAmbiguous = !!db
          .prepare(
            "SELECT 1 FROM documents WHERE bucket_id = ? AND id != ? AND lower(title) = lower(?)",
          )
          .get(newBucketId, id, newTitle);
        replacements.push({ from: oldTitle, to: titleAmbiguous ? newFull : newTitle });
      }
      replacements.push({ from: oldFull, to: newFull });
    }

    // Also rewrite self-links in the document's own body
    if (replacements.length > 0 && row.content_type !== "html") {
      content = replaceWikiLinkTargets(content, replacements);
    }
    const newHash = sha256Hex(content);
    const contentChanged = newHash !== row.content_hash;

    // Snapshot the state being replaced (docs: data-model.md). A pure bucket
    // move is not snapshotted — revisions track content and naming, not home.
    // Renames and moves bypass the coalesce window; only autosave-style
    // content bursts collapse.
    if (contentChanged || titleChanged || pathChanged) {
      snapshotRevision(
        db,
        {
          docId: id,
          title: oldTitle,
          path: row.path,
          content: row.content,
          contentHash: row.content_hash,
          savedAt: row.updated_at,
        },
        { force: titleChanged || pathChanged },
      );
    }

    db.prepare(
      `UPDATE documents SET path = ?, title = ?, content = ?, content_type = ?, source_url = ?,
         content_hash = ?, bucket_id = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      newPath,
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
      // Link resolution is scoped per bucket, so incoming links from the old bucket become unresolved
      db.prepare("UPDATE links SET target_id = NULL WHERE target_id = ?").run(id);
    }

    // Rewrite [[old title]] / [[old/full/path]] in referring documents (same bucket, kura mv behavior)
    let relinked = 0;
    if (replacements.length > 0) {
      const referrers = db
        .prepare("SELECT DISTINCT source_id FROM links WHERE target_id = ? AND source_id != ?")
        .all(id, id) as Array<{ source_id: number }>;
      for (const ref of referrers) {
        const src = getRowById(db, ref.source_id);
        if (src.content_type === "html") continue;
        const rewritten = replaceWikiLinkTargets(src.content, replacements);
        if (rewritten !== src.content) {
          updateDocument(db, src.id, { content: rewritten });
          relinked++;
        }
      }
    }

    if (input.aliases !== undefined && input.aliases.length > 0) {
      addAliasesToDoc(db, id, input.aliases);
    }
    const updatedRow = getRowById(db, id);
    syncDerived(db, updatedRow, {
      tags: input.tags,
      tagSource: input.tagSource,
      // Chunk context headers include the title, so rebuild on rename as well
      rebuildChunks: contentChanged || titleChanged,
      resolveIncoming: titleChanged || pathChanged || bucketChanged,
    });
    return { record: toRecord(db, updatedRow), relinked };
  })();
}

/** kura mv: rename and rewrite [[old title]] in referring documents */
export function renameDocument(db: Database, id: number, newTitle: string): UpdateResult {
  return updateDocument(db, id, { title: newTitle });
}

/** kura mv --path: move a document to another path (title unchanged) */
export function moveDocument(db: Database, id: number, newPath: string): UpdateResult {
  return updateDocument(db, id, { path: newPath });
}

export interface PrefixMoveResult {
  moved: Array<{ key: string; from: string; to: string }>;
  /** Referring documents whose bodies were rewritten across all moves */
  relinked: number;
}

/**
 * kura mv --prefix: move every document under a path prefix (mirrors renameTag,
 * docs: cli-reference.md). Unlike tag renames there is no merge — a destination
 * collision throws ConflictError and rolls back the whole move.
 */
export function moveDocumentsByPrefix(
  db: Database,
  bucketId: number,
  oldRaw: string,
  newRaw: string,
): PrefixMoveResult {
  const oldPrefix = normalizeDocPath(oldRaw);
  const newPrefix = normalizeDocPath(newRaw);
  if (oldPrefix === "") throw new UsageError("old path prefix must not be empty");
  if (oldPrefix === newPrefix) {
    throw new ConflictError(`'${oldPrefix}' and '${newPrefix}' are the same path`);
  }
  if (newPrefix.startsWith(`${oldPrefix}/`)) {
    throw new ConflictError(`cannot move '${oldPrefix}' under its own descendant '${newPrefix}'`);
  }
  return db.transaction(() => {
    const rows = db
      .prepare(
        `SELECT id, doc_key, path, title FROM documents
         WHERE bucket_id = ? AND (lower(path) = lower(?) OR lower(path) LIKE lower(?) || '/%')
         ORDER BY path, title`,
      )
      .all(bucketId, oldPrefix, oldPrefix) as Array<{
      id: number;
      doc_key: string;
      path: string;
      title: string;
    }>;
    if (rows.length === 0) throw new NotFoundError(`no documents under path '${oldPrefix}'`);

    const moved: PrefixMoveResult["moved"] = [];
    let relinked = 0;
    for (const row of rows) {
      const dest = normalizeDocPath(newPrefix + row.path.slice(oldPrefix.length));
      const result = updateDocument(db, row.id, { path: dest });
      moved.push({
        key: row.doc_key,
        from: joinDocPath(row.path, row.title),
        to: joinDocPath(result.record.path, result.record.title),
      });
      relinked += result.relinked;
    }
    return { moved, relinked };
  })();
}

/**
 * kura clip: create, retrying title collisions with 'title (2)', 'title (3)', ...
 * (docs: cli-reference.md). Non-conflict errors propagate unchanged.
 */
export function createDocumentWithRetry(
  db: Database,
  input: CreateDocumentInput,
  maxAttempts = 50,
): DocumentRecord {
  for (let n = 1; n <= maxAttempts; n++) {
    const title = n === 1 ? input.title : `${input.title} (${n})`;
    try {
      return createDocument(db, { ...input, title });
    } catch (e) {
      if (!(e instanceof ConflictError)) throw e;
    }
  }
  throw new ConflictError(
    `could not find an available title for '${input.title}' after ${maxAttempts} attempts`,
  );
}

export function deleteDocument(db: Database, id: number): void {
  db.transaction(() => {
    getRowById(db, id);
    db.prepare(
      "DELETE FROM chunks_vec WHERE chunk_id IN (SELECT id FROM chunks WHERE document_id = ?)",
    ).run(id);
    ftsDelete(db, id);
    // chunks / document_tags / links(source) CASCADE; incoming links go back to unresolved via SET NULL
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
 * Resolve a document specifier (docs: cli-reference.md): doc_key / #key /
 * full path / a title unique among the searched documents / a unique alias.
 * Ambiguous matches throw ConflictError listing the candidates.
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

  const candidates = (rows: DocRow[]) =>
    rows.map((r) => `#${r.doc_key} (${r.bucket}${r.path === "" ? "" : `, ${r.path}/`})`).join(", ");

  // Stage 1: computed full path (unique per bucket; several matches means several buckets)
  const FULL = `lower(${fullPathSql("d")}) = lower(?)`;
  const fullRows = (
    bucketName
      ? db.prepare(`${SELECT_DOC} WHERE ${FULL} AND b.name = ?`).all(trimmed, bucketName)
      : db.prepare(`${SELECT_DOC} WHERE ${FULL}`).all(trimmed)
  ) as DocRow[];
  if (fullRows.length === 1) return toRecord(db, fullRows[0]!);
  if (fullRows.length > 1) {
    throw new ConflictError(
      `'${trimmed}' is ambiguous across buckets: ${candidates(fullRows)}. Use #key or --bucket`,
    );
  }

  // Stage 2: title, unique among the searched documents
  const rows = (
    bucketName
      ? db
          .prepare(`${SELECT_DOC} WHERE lower(d.title) = lower(?) AND b.name = ?`)
          .all(trimmed, bucketName)
      : db.prepare(`${SELECT_DOC} WHERE lower(d.title) = lower(?)`).all(trimmed)
  ) as DocRow[];
  if (rows.length === 1) return toRecord(db, rows[0]!);
  if (rows.length > 1) {
    throw new ConflictError(
      `title '${trimmed}' is ambiguous: ${candidates(rows)}. Use #key, the full path, or --bucket`,
    );
  }

  // Stage 3: alias, unique among the searched documents
  const ALIAS = `EXISTS (SELECT 1 FROM document_aliases da
    WHERE da.document_id = d.id AND lower(da.alias) = lower(?))`;
  const aliasRows = (
    bucketName
      ? db.prepare(`${SELECT_DOC} WHERE ${ALIAS} AND b.name = ?`).all(trimmed, bucketName)
      : db.prepare(`${SELECT_DOC} WHERE ${ALIAS}`).all(trimmed)
  ) as DocRow[];

  if (aliasRows.length === 0) throw new NotFoundError(`document not found: ${trimmed}`);
  if (aliasRows.length > 1) {
    throw new ConflictError(
      `alias '${trimmed}' is ambiguous: ${candidates(aliasRows)}. Use #key, the full path, or --bucket`,
    );
  }
  return toRecord(db, aliasRows[0]!);
}

/** Record access from get / MCP get / search-result content fetches (docs: data-model.md) */
export function touchAccess(db: Database, id: number): void {
  db.prepare(
    "UPDATE documents SET access_count = access_count + 1, last_accessed_at = datetime('now') WHERE id = ?",
  ).run(id);
}

/**
 * Pin / unpin a document in the browser sidebar. Deliberately not part of
 * updateDocument: starring is not an edit, so it must not touch updated_at (a
 * favorite would otherwise jump to the top of every "recently updated" list) and
 * it leaves the derived tables alone — the flag is not indexed, linked or chunked.
 */
export function setFavorite(db: Database, id: number, favorite: boolean): DocumentRecord {
  db.prepare("UPDATE documents SET favorite = ? WHERE id = ?").run(favorite ? 1 : 0, id);
  return getDocumentById(db, id);
}

/**
 * Stamp a document as triaged. Runtime bookkeeping like access tracking: it
 * deliberately does not touch updated_at (a triage is not an edit) and leaves
 * the derived tables alone. The backlog is (unfiled OR untagged) AND
 * (triaged_at IS NULL OR updated_at > triaged_at), so a later edit re-enters
 * the document into the backlog (docs: self-healing.md).
 */
export function markTriaged(db: Database, id: number, at?: string): DocumentRecord {
  db.prepare("UPDATE documents SET triaged_at = ? WHERE id = ?").run(
    at ?? sqliteNow(new Date()),
    id,
  );
  return getDocumentById(db, id);
}

/**
 * Canonical backlog predicates (docs: self-healing.md), composed into the
 * listDocuments filter, the triage backlog query (src/core/triage.ts), and the
 * status counts (src/core/stats.ts). Every consumer aliases documents as `d`
 * and document_tags as `dt`.
 */
export const UNFILED_WHERE = "d.path = ''";
export const UNTAGGED_WHERE =
  "NOT EXISTS (SELECT 1 FROM document_tags dt WHERE dt.document_id = d.id)";
export const UNTRIAGED_WHERE = "(d.triaged_at IS NULL OR d.updated_at > d.triaged_at)";

export interface ListFilter {
  bucket?: string;
  /** Tag (descendant tags included) */
  tag?: string;
  /** Document path (descendant paths included) */
  prefix?: string;
  /** Only favorites */
  favorite?: boolean;
  /** Only documents at the bucket root (path = '') — the filing backlog */
  unfiled?: boolean;
  /** Only documents with no tags */
  untagged?: boolean;
  sort?: "updated" | "created" | "accessed" | "title" | "views";
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
  views: "d.access_count DESC, d.last_accessed_at IS NULL, d.last_accessed_at DESC",
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
  if (filter.prefix) {
    where.push("(lower(d.path) = lower(?) OR lower(d.path) LIKE lower(?) || '/%')");
    params.push(filter.prefix, filter.prefix);
  }
  if (filter.favorite) {
    where.push("d.favorite = 1");
  }
  if (filter.unfiled) {
    where.push(UNFILED_WHERE);
  }
  if (filter.untagged) {
    where.push(UNTAGGED_WHERE);
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
  const ids = rows.map((r) => r.id);
  const tags = docTagsBatch(db, ids);
  const aliases = docAliasesBatch(db, ids);
  return rows.map((r) =>
    toRecord(db, r, { tags: tags.get(r.id) ?? [], aliases: aliases.get(r.id) ?? [] }),
  );
}

function sqliteNow(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

export interface DocTreeNode {
  /** Path segment for branches; the document title for document nodes */
  segment: string;
  /** Path prefix for branches; the computed full path for document nodes */
  path: string;
  /** doc_key when this node is a document (a branch can also be one) */
  key?: string;
  /** Documents in this subtree (a document node counts itself) */
  total: number;
  children: DocTreeNode[];
}

export interface DocTreeEntry {
  key: string;
  path: string;
  title: string;
}

/**
 * Build a bucket's documents into a path hierarchy (mirrors buildTagTree,
 * docs: browser-ui.md). Branch nodes come from path prefixes; documents
 * attach as leaves, or merge into the branch whose path equals their
 * computed full path (a "folder" that is itself a document). Branches are
 * memoized case-insensitively, matching path comparison semantics.
 */
export function buildDocTree(entries: DocTreeEntry[]): DocTreeNode[] {
  const roots: DocTreeNode[] = [];
  const index = new Map<string, DocTreeNode>();

  const ensureBranch = (path: string): DocTreeNode => {
    const memoKey = path.toLowerCase();
    const existing = index.get(memoKey);
    if (existing) return existing;
    const idx = path.lastIndexOf("/");
    const node: DocTreeNode = {
      segment: idx === -1 ? path : path.slice(idx + 1),
      path,
      total: 0,
      children: [],
    };
    index.set(memoKey, node);
    if (idx === -1) roots.push(node);
    else ensureBranch(path.slice(0, idx)).children.push(node);
    return node;
  };

  // Branches first so that document placement is order-independent
  for (const entry of entries) {
    if (entry.path !== "") ensureBranch(entry.path);
  }
  for (const entry of entries) {
    const full = joinDocPath(entry.path, entry.title);
    const branch = index.get(full.toLowerCase());
    if (branch && branch.key === undefined) {
      branch.key = entry.key;
      continue;
    }
    const node: DocTreeNode = {
      segment: entry.title,
      path: full,
      key: entry.key,
      total: 0,
      children: [],
    };
    if (entry.path === "") roots.push(node);
    else ensureBranch(entry.path).children.push(node);
  }

  const sum = (node: DocTreeNode): number => {
    node.total =
      (node.key === undefined ? 0 : 1) + node.children.reduce((acc, c) => acc + sum(c), 0);
    return node.total;
  };
  const sort = (nodes: DocTreeNode[]): void => {
    // File-manager order: subtrees first, then documents, each alphabetical
    nodes.sort((a, b) => {
      const aBranch = a.children.length > 0;
      const bBranch = b.children.length > 0;
      if (aBranch !== bBranch) return aBranch ? -1 : 1;
      return a.segment.localeCompare(b.segment, "ja");
    });
    for (const n of nodes) sort(n.children);
  };
  for (const r of roots) sum(r);
  sort(roots);
  return roots;
}

/** Document tree of one bucket, for the browser sidebar (GET /api/docs/tree) */
export function docTree(db: Database, bucketName: string): DocTreeNode[] {
  const rows = db
    .prepare(
      `SELECT d.doc_key AS key, d.path, d.title FROM documents d
       JOIN buckets b ON b.id = d.bucket_id WHERE b.name = ?
       ORDER BY d.path, d.title`,
    )
    .all(bucketName) as DocTreeEntry[];
  return buildDocTree(rows);
}

export interface ImportInput {
  fm: Frontmatter | null;
  body: string;
  /** Fallback when frontmatter has no title (e.g. the file name) */
  fallbackTitle: string;
  /** Fallback when frontmatter has no path (the file's subdirectory relative to the scanned root) */
  fallbackPath?: string;
  /** --bucket flag (takes precedence over frontmatter) */
  bucketOverride?: string;
  defaultBucket: string;
}

export interface ImportResult {
  record: DocumentRecord;
  action: "created" | "updated";
}

/** Import Markdown with frontmatter. Updates when kura_key exists, creates otherwise (docs: cli-reference.md) */
export function importDocument(db: Database, input: ImportInput): ImportResult {
  return db.transaction(() => {
    const fm = input.fm;
    const bucketName = input.bucketOverride ?? fm?.bucket ?? input.defaultBucket;
    getOrCreateBucket(db, bucketName);
    const title = fm?.title ?? input.fallbackTitle;

    // Frontmatter path wins; otherwise the on-disk subdirectory, with the
    // leading segment stripped when it equals the bucket name so that a
    // `kura export` tree (<dir>/<bucket>/<path...>) re-imports cleanly
    let path = fm?.path;
    if (path === undefined) {
      const segments = normalizeDocPath(input.fallbackPath ?? "")
        .split("/")
        .filter((s) => s !== "");
      if (segments[0] === bucketName) segments.shift();
      path = segments.join("/");
    }

    // export only writes `favorite: true`, so an absent key means "leave it as it is"
    // rather than "unstar" — a hand-written file never silently drops a pin
    const pin = (record: DocumentRecord): DocumentRecord =>
      fm?.favorite === undefined ? record : setFavorite(db, record.id, fm.favorite);

    const existing = fm?.kura_key ? getDocumentByKey(db, fm.kura_key) : null;
    if (existing) {
      const { record } = updateDocument(db, existing.id, {
        title,
        content: input.body,
        bucket: bucketName,
        path,
        contentType: fm?.content_type,
        sourceUrl: fm?.source_url ?? existing.sourceUrl,
        tags: fm?.tags,
        aliases: fm?.aliases,
        updatedAt: fm?.updated_at,
      });
      return { record: pin(record), action: "updated" as const };
    }

    const record = createDocument(db, {
      title,
      content: input.body,
      bucket: bucketName,
      path,
      contentType: fm?.content_type,
      sourceUrl: fm?.source_url ?? null,
      tags: fm?.tags,
      aliases: fm?.aliases,
      docKey: fm?.kura_key,
      createdAt: fm?.created_at,
      updatedAt: fm?.updated_at,
    });
    return { record: pin(record), action: "created" as const };
  })();
}
