-- I14B：外部快照不变；市场报价是可重放的本服投影，保留输入、原因和规则版本。
CREATE TABLE IF NOT EXISTS market_parameters (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  rule_version TEXT NOT NULL,
  eur_cent_to_game_credit_bps INTEGER NOT NULL CHECK (eur_cent_to_game_credit_bps BETWEEN 1 AND 1000000),
  minimum_price INTEGER NOT NULL CHECK (minimum_price >= 0),
  npc_buy_spread_bps INTEGER NOT NULL CHECK (npc_buy_spread_bps BETWEEN 0 AND 9999),
  npc_sell_spread_bps INTEGER NOT NULL CHECK (npc_sell_spread_bps BETWEEN 0 AND 100000),
  npc_fee_bps INTEGER NOT NULL CHECK (npc_fee_bps BETWEEN 0 AND 100000),
  updated_at TEXT NOT NULL
);
INSERT INTO market_parameters (singleton, rule_version, eur_cent_to_game_credit_bps, minimum_price, npc_buy_spread_bps, npc_sell_spread_bps, npc_fee_bps, updated_at)
VALUES (1, 'market/v1', 10000, 1, 1000, 1000, 0, '2026-07-27T00:00:00.000Z')
ON CONFLICT(singleton) DO NOTHING;

INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES ('market-v1', 'market', 'market/v1', '{"factorBoundsBp":[5000,20000],"defaultParameters":{"eurCentToGameCreditBp":10000,"minimumPrice":1,"npcBuySpreadBp":1000,"npcSellSpreadBp":1000,"npcFeeBp":0}}', '2026-07-27T00:00:00.000Z', NULL)
ON CONFLICT(rule_set, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS market_series_cycles (
  id TEXT PRIMARY KEY,
  set_id TEXT NOT NULL REFERENCES card_sets(id),
  factor_bps INTEGER NOT NULL CHECK (factor_bps BETWEEN 5000 AND 20000),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL CHECK (ends_at > starts_at),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS market_series_cycles_active_index ON market_series_cycles(set_id, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS market_card_relations (
  id TEXT PRIMARY KEY,
  source_sku_id TEXT NOT NULL REFERENCES card_skus(id),
  target_sku_id TEXT NOT NULL REFERENCES card_skus(id),
  weight_bps INTEGER NOT NULL CHECK (weight_bps BETWEEN 0 AND 10000),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source_sku_id, target_sku_id)
);

CREATE TABLE IF NOT EXISTS market_events (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'set', 'sku')),
  scope_id TEXT,
  factor_bps INTEGER NOT NULL CHECK (factor_bps BETWEEN 5000 AND 20000),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL CHECK (ends_at > starts_at),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK ((scope_type = 'global' AND scope_id IS NULL) OR (scope_type IN ('set', 'sku') AND scope_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS market_events_active_index ON market_events(scope_type, scope_id, starts_at, ends_at);

CREATE TABLE IF NOT EXISTS market_quotes (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  price_snapshot_entry_id TEXT NOT NULL REFERENCES price_snapshot_entries(id),
  trigger_key TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  reference_price_eur_cents INTEGER NOT NULL CHECK (reference_price_eur_cents > 0),
  market_price_amount INTEGER NOT NULL CHECK (market_price_amount >= 0),
  npc_buy_price_amount INTEGER NOT NULL CHECK (npc_buy_price_amount >= 0),
  npc_sell_price_amount INTEGER NOT NULL CHECK (npc_sell_price_amount >= 0),
  npc_buy_fee_amount INTEGER NOT NULL CHECK (npc_buy_fee_amount >= 0),
  npc_sell_fee_amount INTEGER NOT NULL CHECK (npc_sell_fee_amount >= 0),
  parameters_json TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  calculated_at TEXT NOT NULL,
  valid_until TEXT NOT NULL,
  UNIQUE(sku_id, trigger_key)
);
CREATE INDEX IF NOT EXISTS market_quotes_sku_calculated_index ON market_quotes(sku_id, calculated_at DESC);
