-- v2: hierarchical document paths (docs: data-model.md)
-- Rebuilds documents to change UNIQUE(bucket_id, title) into
-- UNIQUE(bucket_id, path, title). ids are preserved: documents_fts rowid and
-- the links / document_tags / chunks foreign keys all reference documents.id.
-- The migration runner disables foreign_keys around this script (a DROP TABLE
-- with them enabled would fire the ON DELETE actions and wipe derived tables)
-- and runs PRAGMA foreign_key_check before COMMIT.

CREATE TABLE documents_new (
  id               INTEGER PRIMARY KEY,
  doc_key          TEXT NOT NULL UNIQUE,
  bucket_id        INTEGER NOT NULL REFERENCES buckets(id),
  title            TEXT NOT NULL,
  content          TEXT NOT NULL,
  content_type     TEXT NOT NULL DEFAULT 'markdown',
  source_url       TEXT,
  content_hash     TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
  last_accessed_at TEXT,
  access_count     INTEGER NOT NULL DEFAULT 0,
  path             TEXT NOT NULL DEFAULT '',
  UNIQUE (bucket_id, path, title)
);

INSERT INTO documents_new
  (id, doc_key, bucket_id, title, content, content_type, source_url,
   content_hash, created_at, updated_at, last_accessed_at, access_count, path)
SELECT id, doc_key, bucket_id, title, content, content_type, source_url,
       content_hash, created_at, updated_at, last_accessed_at, access_count, ''
FROM documents;

DROP TABLE documents;
ALTER TABLE documents_new RENAME TO documents;

-- Recreate the indexes v1 defined on documents (dropped with the table)
CREATE INDEX idx_documents_bucket ON documents(bucket_id);
CREATE INDEX idx_documents_updated ON documents(updated_at);
