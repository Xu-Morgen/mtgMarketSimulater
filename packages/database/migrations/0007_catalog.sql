CREATE TABLE IF NOT EXISTS card_sets (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  released_at TEXT,
  source TEXT NOT NULL CHECK (source IN ('scryfall', 'manual-test')),
  source_reference TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_printings (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES card_sets(id),
  name TEXT NOT NULL,
  collector_number TEXT NOT NULL,
  scryfall_id TEXT,
  oracle_text TEXT,
  rarity TEXT NOT NULL,
  legalities_json TEXT NOT NULL,
  artist TEXT,
  source TEXT NOT NULL CHECK (source IN ('scryfall', 'manual-test')),
  source_reference TEXT,
  is_manual_exception INTEGER NOT NULL DEFAULT 0 CHECK (is_manual_exception IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(set_id, collector_number),
  CHECK ((source = 'manual-test' AND is_manual_exception = 1) OR (source = 'scryfall' AND is_manual_exception = 0))
);
CREATE INDEX IF NOT EXISTS card_printings_name_index ON card_printings(name);

CREATE TABLE IF NOT EXISTS card_skus (
  id TEXT PRIMARY KEY,
  printing_id TEXT NOT NULL REFERENCES card_printings(id),
  finish TEXT NOT NULL CHECK (finish IN ('nonfoil', 'foil', 'etched')),
  tradable INTEGER NOT NULL DEFAULT 0 CHECK (tradable IN (0, 1)),
  source TEXT NOT NULL CHECK (source IN ('scryfall', 'manual-test')),
  source_reference TEXT,
  is_manual_exception INTEGER NOT NULL DEFAULT 0 CHECK (is_manual_exception IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(printing_id, finish),
  CHECK ((source = 'manual-test' AND is_manual_exception = 1) OR (source = 'scryfall' AND is_manual_exception = 0))
);
CREATE INDEX IF NOT EXISTS card_skus_printing_index ON card_skus(printing_id);

CREATE TABLE IF NOT EXISTS card_image_cache (
  id TEXT PRIMARY KEY,
  printing_id TEXT NOT NULL REFERENCES card_printings(id),
  source_url TEXT,
  cache_path TEXT,
  status TEXT NOT NULL CHECK (status IN ('missing', 'cached', 'failed')),
  checksum TEXT,
  cached_at TEXT,
  failure_reason TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(printing_id),
  CHECK ((status = 'cached' AND cache_path IS NOT NULL AND cached_at IS NOT NULL) OR status IN ('missing', 'failed'))
);
