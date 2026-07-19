-- v5: document revisions (docs: data-model.md)
-- Every content / title / path change snapshots the state being replaced, so
-- edits are recoverable (kura history) and past states are addressable
-- (kura get --as-of). saved_at is the updated_at the state carried while it
-- was current; created_at is when the snapshot row was written. Rows are
-- pruned per document and coalesced per editing burst in the repository
-- layer, never by triggers.

CREATE TABLE document_revisions (
  id           INTEGER PRIMARY KEY,
  document_id  INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  path         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  saved_at     TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_document_revisions_doc ON document_revisions(document_id, id);
