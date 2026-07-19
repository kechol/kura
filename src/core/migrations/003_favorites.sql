-- v3: favorite documents (docs: data-model.md)
-- A plain column, not a join table: a favorite is a per-document boolean with no
-- extra attributes, and the sidebar reads it on every render. The partial index
-- keeps that read proportional to the number of favorites, not the store size.

ALTER TABLE documents ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
CREATE INDEX idx_documents_favorite ON documents(favorite) WHERE favorite = 1;
