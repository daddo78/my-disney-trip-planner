-- One row per planner doc, same shape as the claude.ai artifact's db: collection, id, JSON data.
-- `updated` is a strictly increasing counter used by phones to fetch only what changed.
CREATE TABLE IF NOT EXISTS docs (
  coll TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  PRIMARY KEY (coll, id)
);
CREATE INDEX IF NOT EXISTS docs_updated ON docs (updated);
