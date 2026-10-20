-- paper-store schema: one row per account token, holding the page's entire persisted state
-- (paper balance + bet history + your settings) as one JSON blob. This replaces the segmented
-- settings/big_<key>_<i> scheme the Claude-artifact version used (ArtifactData's own doc-size
-- limits drove that design; a plain D1 TEXT column has no such limit at this size).
CREATE TABLE IF NOT EXISTS state (
  token TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
