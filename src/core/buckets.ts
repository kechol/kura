import type { Database } from "bun:sqlite";
import { ConflictError, NotFoundError, UsageError } from "./errors";

export interface Bucket {
  id: number;
  name: string;
  description: string | null;
  createdAt: string;
}

/** Bucket 名は小文字英数と - のみ（SPEC §3.1） */
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export function validateBucketName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new UsageError(`invalid bucket name: '${name}' (lowercase alphanumerics and '-' only)`);
  }
}

interface BucketRow {
  id: number;
  name: string;
  description: string | null;
  created_at: string;
}

function toBucket(row: BucketRow): Bucket {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
  };
}

export function listBuckets(db: Database): Array<Bucket & { documents: number }> {
  const rows = db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM documents d WHERE d.bucket_id = b.id) AS documents
       FROM buckets b ORDER BY b.name`,
    )
    .all() as Array<BucketRow & { documents: number }>;
  return rows.map((r) => ({ ...toBucket(r), documents: r.documents }));
}

export function getBucket(db: Database, name: string): Bucket | null {
  const row = db.prepare("SELECT * FROM buckets WHERE name = ?").get(name) as BucketRow | null;
  return row ? toBucket(row) : null;
}

export function requireBucket(db: Database, name: string): Bucket {
  const bucket = getBucket(db, name);
  if (!bucket) throw new NotFoundError(`bucket not found: ${name}`);
  return bucket;
}

export function createBucket(db: Database, name: string, description?: string): Bucket {
  validateBucketName(name);
  if (getBucket(db, name)) throw new ConflictError(`bucket already exists: ${name}`);
  db.prepare("INSERT INTO buckets (name, description) VALUES (?, ?)").run(
    name,
    description ?? null,
  );
  return requireBucket(db, name);
}

/** import 用: 無ければ作成して返す */
export function getOrCreateBucket(db: Database, name: string): Bucket {
  return getBucket(db, name) ?? createBucket(db, name);
}

export function renameBucket(db: Database, oldName: string, newName: string): void {
  validateBucketName(newName);
  const bucket = requireBucket(db, oldName);
  if (getBucket(db, newName)) throw new ConflictError(`bucket already exists: ${newName}`);
  db.prepare("UPDATE buckets SET name = ? WHERE id = ?").run(newName, bucket.id);
}

/** 空の Bucket を削除する。非空は呼び出し側でドキュメント削除後に呼ぶこと */
export function deleteBucket(db: Database, name: string): void {
  const bucket = requireBucket(db, name);
  const docs = (
    db.prepare("SELECT COUNT(*) AS n FROM documents WHERE bucket_id = ?").get(bucket.id) as {
      n: number;
    }
  ).n;
  if (docs > 0) {
    throw new ConflictError(`bucket '${name}' is not empty (${docs} documents)`);
  }
  db.prepare("DELETE FROM buckets WHERE id = ?").run(bucket.id);
}
