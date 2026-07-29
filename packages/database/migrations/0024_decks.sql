-- I24B：可重放的 Commander 构筑快照。虚拟基本地绝不进入 inventory_* 表。
ALTER TABLE card_printings ADD COLUMN oracle_id TEXT;
ALTER TABLE card_printings ADD COLUMN color_identity_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE card_printings ADD COLUMN type_line TEXT NOT NULL DEFAULT '';
ALTER TABLE card_printings ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE card_printings ADD COLUMN mana_value INTEGER NOT NULL DEFAULT 0 CHECK (mana_value >= 0);

CREATE TABLE commander_banlist_versions (
  version TEXT PRIMARY KEY,
  banned_names_json TEXT NOT NULL,
  banned_as_companion_names_json TEXT NOT NULL,
  source_reference TEXT NOT NULL,
  published_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
INSERT INTO commander_banlist_versions (version, banned_names_json, banned_as_companion_names_json, source_reference, published_at, created_at)
VALUES ('commander-banlist/2026-02-09',
  '["Ancestral Recall","Balance","Black Lotus","Chaos Orb","Channel","Dockside Extortionist","Emrakul, the Aeons Torn","Erayo, Soratami Ascendant","Falling Star","Fastbond","Flash","Golos, Tireless Pilgrim","Griselbrand","Hullbreacher","Iona, Shield of Emeria","Karakas","Jeweled Lotus","Leovold, Emissary of Trest","Library of Alexandria","Limited Resources","Mana Crypt","Mox Emerald","Mox Jet","Mox Pearl","Mox Ruby","Mox Sapphire","Painter''s Servant","Paradox Engine","Primeval Titan","Prophet of Kruphix","Recurring Nightmare","Rofellos, Llanowar Emissary","Shahrazad","Sundering Titan","Time Vault","Time Walk","Tinker","Tolarian Academy","Trade Secrets","Upheaval","Yawgmoth''s Bargain"]',
  '["Lutri, the Spellchaser"]', 'magic.wizards.com/en/banned-restricted-list', '2026-02-09T00:00:00.000Z', '2026-07-29T00:00:00.000Z');

CREATE TABLE decks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  format TEXT NOT NULL CHECK (format = 'commander-100/v1'),
  rule_version TEXT NOT NULL,
  banlist_version TEXT NOT NULL REFERENCES commander_banlist_versions(version),
  legality_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX decks_user_updated_index ON decks(user_id, updated_at DESC, id DESC);
CREATE TABLE deck_cards (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  zone TEXT NOT NULL CHECK (zone IN ('commander', 'main', 'companion', 'virtual_basic')),
  sku_id TEXT REFERENCES card_skus(id),
  virtual_basic TEXT CHECK (virtual_basic IN ('plains', 'island', 'swamp', 'mountain', 'forest')),
  card_identity TEXT NOT NULL,
  card_name TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  CHECK ((zone = 'virtual_basic' AND sku_id IS NULL AND virtual_basic IS NOT NULL) OR (zone != 'virtual_basic' AND sku_id IS NOT NULL AND virtual_basic IS NULL)),
  UNIQUE(deck_id, zone, sku_id),
  UNIQUE(deck_id, zone, virtual_basic)
);
CREATE INDEX deck_cards_deck_index ON deck_cards(deck_id, zone);

-- 仅在 I25B 报名成功后才会写入。响应密文永不加入玩家 DTO。
CREATE TABLE deck_power_snapshots (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES decks(id),
  registration_id TEXT UNIQUE,
  source TEXT NOT NULL CHECK (source IN ('leyline', 'local', 'ml')),
  source_version TEXT NOT NULL,
  provider_algorithm_version TEXT,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  input_summary_sha256 TEXT NOT NULL,
  computed_at TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('available', 'degraded')),
  degradation_reason TEXT,
  response_sha256 TEXT,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE deck_leyline_source_records (
  id TEXT PRIMARY KEY,
  power_snapshot_id TEXT NOT NULL UNIQUE REFERENCES deck_power_snapshots(id),
  adapter_version TEXT NOT NULL,
  request_decklist_sha256 TEXT NOT NULL,
  response_sha256 TEXT NOT NULL,
  encrypted_response BLOB NOT NULL,
  encryption_nonce BLOB NOT NULL,
  encryption_tag BLOB NOT NULL,
  created_at TEXT NOT NULL
);
