CREATE TABLE IF NOT EXISTS catalog_sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source = 'scryfall-bulk'),
  source_version TEXT NOT NULL,
  source_uri TEXT NOT NULL,
  checksum_sha256 TEXT NOT NULL,
  enabled_sets_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  imported_printings INTEGER NOT NULL DEFAULT 0,
  imported_skus INTEGER NOT NULL DEFAULT 0,
  cached_images INTEGER NOT NULL DEFAULT 0,
  diff_json TEXT NOT NULL,
  failure_reason TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS catalog_sync_runs_status_started_index ON catalog_sync_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS catalog_sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  latest_successful_run_id TEXT REFERENCES catalog_sync_runs(id),
  updated_at TEXT NOT NULL
);
