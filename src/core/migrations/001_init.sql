-- v1: 初期スキーマ（SPEC §3.1）
-- {{FTS_TOKENIZE}} / {{VEC_DIMENSIONS}} はマイグレーションランナーが実行時に置換する

-- Bucket: ナレッジの大分類
CREATE TABLE buckets (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO buckets (name, description) VALUES ('main', 'Default bucket');

CREATE TABLE documents (
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
  UNIQUE (bucket_id, title)
);
CREATE INDEX idx_documents_bucket ON documents(bucket_id);
CREATE INDEX idx_documents_updated ON documents(updated_at);

-- タグ: スラッシュ区切りの階層パス（正規化済み）
CREATE TABLE tags (
  id   INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE
);

CREATE TABLE document_tags (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tag_id      INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source      TEXT NOT NULL DEFAULT 'manual',
  PRIMARY KEY (document_id, tag_id)
);

-- 相互リンク: [[タイトル]] の抽出結果。target_id が NULL なら未解決
CREATE TABLE links (
  id           INTEGER PRIMARY KEY,
  source_id    INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  target_id    INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  target_title TEXT NOT NULL,
  UNIQUE (source_id, target_title)
);
CREATE INDEX idx_links_target ON links(target_id);
CREATE INDEX idx_links_unresolved ON links(target_title) WHERE target_id IS NULL;

-- チャンク: embedding の単位。embedded_at が NULL ならバックフィル対象
CREATE TABLE chunks (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL,
  text         TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  embedded_at  TEXT,
  UNIQUE (document_id, seq)
);

-- FTS5: rowid = documents.id。同期はリポジトリ層が同一トランザクションで行う
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, content, tags,
  tokenize='{{FTS_TOKENIZE}}'
);

-- sqlite-vec: チャンク embedding
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[{{VEC_DIMENSIONS}}]
);

-- LLM 応答キャッシュ
CREATE TABLE llm_cache (
  cache_key  TEXT PRIMARY KEY,
  purpose    TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- システムメタ情報（fts_tokenizer / embedding_model / embedding_dimensions など）
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
