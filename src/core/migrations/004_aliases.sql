-- v4: document aliases (docs: data-model.md)
-- Aliases are alternate titles: they join wiki-link / resolveDoc resolution as
-- a third stage and are FTS-indexed so orthographic variants (サーバ/サーバー)
-- find the document. Stored per document like tags; case is preserved, matching
-- is case-insensitive via the lower() indexes.

CREATE TABLE document_aliases (
  id          INTEGER PRIMARY KEY,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  alias       TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_document_aliases_doc_alias ON document_aliases(document_id, lower(alias));
CREATE INDEX idx_document_aliases_alias ON document_aliases(lower(alias));

-- FTS5 cannot ALTER ADD COLUMN: recreate documents_fts with the aliases column
-- and repopulate. Aliases start empty (the table above was just created).
DROP TABLE documents_fts;
CREATE VIRTUAL TABLE documents_fts USING fts5(
  title, content, tags, aliases,
  tokenize='{{FTS_TOKENIZE}}'
);
INSERT INTO documents_fts (rowid, title, content, tags, aliases)
SELECT d.id, d.title, d.content,
       COALESCE((SELECT group_concat(t.path, ' ') FROM document_tags dt
                 JOIN tags t ON t.id = dt.tag_id WHERE dt.document_id = d.id), ''),
       ''
FROM documents d;
