-- v6: document triage state (docs: data-model.md)
-- A plain nullable column, not a join table: triage is a per-document timestamp
-- with no extra attributes. NULL means never triaged. The triage backlog is
-- (unfiled OR untagged) AND (triaged_at IS NULL OR updated_at > triaged_at), so
-- editing a document after triage re-enters it into the backlog. No index: the
-- backlog is computed on demand, not read on every render.

ALTER TABLE documents ADD COLUMN triaged_at TEXT;
