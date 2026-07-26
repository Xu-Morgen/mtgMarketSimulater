CREATE TABLE IF NOT EXISTS price_sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL CHECK (source = 'mtgjson-cardmarket'),
  source_version TEXT NOT NULL,
  prices_uri TEXT NOT NULL,
  mapping_uri TEXT NOT NULL,
  prices_checksum_sha256 TEXT NOT NULL,
  mapping_checksum_sha256 TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  mapped_skus INTEGER NOT NULL DEFAULT 0,
  priced_skus INTEGER NOT NULL DEFAULT 0,
  unpriced_skus INTEGER NOT NULL DEFAULT 0,
  mapping_failed_skus INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS price_sync_runs_status_started_index ON price_sync_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS price_sync_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  latest_successful_run_id TEXT REFERENCES price_sync_runs(id),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_sku_mappings (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL REFERENCES price_sync_runs(id),
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  scryfall_id TEXT NOT NULL,
  mtgjson_uuid TEXT NOT NULL,
  finish TEXT NOT NULL CHECK (finish IN ('nonfoil', 'foil', 'etched')),
  created_at TEXT NOT NULL,
  UNIQUE(sync_run_id, sku_id),
  UNIQUE(sync_run_id, mtgjson_uuid, finish)
);
CREATE INDEX IF NOT EXISTS price_sku_mappings_sku_index ON price_sku_mappings(sku_id, created_at DESC);

CREATE TABLE IF NOT EXISTS price_snapshot_entries (
  id TEXT PRIMARY KEY,
  sync_run_id TEXT NOT NULL REFERENCES price_sync_runs(id),
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  mapping_id TEXT REFERENCES price_sku_mappings(id),
  mtgjson_uuid TEXT,
  finish TEXT NOT NULL CHECK (finish IN ('nonfoil', 'foil', 'etched')),
  price_type TEXT NOT NULL CHECK (price_type IN ('normal', 'foil', 'etched')),
  currency TEXT NOT NULL,
  price_amount INTEGER,
  availability TEXT NOT NULL CHECK (availability IN ('priced', 'no_price', 'mapping_failed')),
  unavailable_reason TEXT,
  captured_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(sync_run_id, sku_id)
);
CREATE INDEX IF NOT EXISTS price_snapshot_entries_sku_captured_index ON price_snapshot_entries(sku_id, captured_at DESC);
