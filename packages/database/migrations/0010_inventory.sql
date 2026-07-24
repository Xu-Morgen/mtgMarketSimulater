CREATE TABLE inventory_holdings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  available_quantity INTEGER NOT NULL CHECK (available_quantity >= 0),
  order_locked_quantity INTEGER NOT NULL CHECK (order_locked_quantity >= 0),
  tournament_locked_quantity INTEGER NOT NULL CHECK (tournament_locked_quantity >= 0),
  average_cost_amount INTEGER NOT NULL CHECK (average_cost_amount >= 0),
  market_value_amount INTEGER CHECK (market_value_amount >= 0),
  market_value_captured_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (quantity = available_quantity + order_locked_quantity + tournament_locked_quantity)
);
CREATE UNIQUE INDEX inventory_holdings_user_sku_unique ON inventory_holdings(user_id, sku_id);
CREATE INDEX inventory_holdings_user_updated_index ON inventory_holdings(user_id, updated_at);

CREATE TABLE inventory_holds (
  id TEXT PRIMARY KEY,
  holding_id TEXT NOT NULL REFERENCES inventory_holdings(id),
  reason TEXT NOT NULL CHECK (reason IN ('order', 'tournament')),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'released', 'captured')),
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE INDEX inventory_holds_holding_status_index ON inventory_holds(holding_id, status);
CREATE UNIQUE INDEX inventory_holds_entity_unique ON inventory_holds(holding_id, reason, entity_type, entity_id);

CREATE TABLE inventory_entries (
  id TEXT PRIMARY KEY,
  holding_id TEXT NOT NULL REFERENCES inventory_holdings(id),
  reason TEXT NOT NULL,
  quantity_delta INTEGER NOT NULL,
  available_quantity_delta INTEGER NOT NULL,
  order_locked_quantity_delta INTEGER NOT NULL,
  tournament_locked_quantity_delta INTEGER NOT NULL,
  quantity_after INTEGER NOT NULL CHECK (quantity_after >= 0),
  average_cost_after INTEGER NOT NULL CHECK (average_cost_after >= 0),
  correlation_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX inventory_entries_holding_occurred_index ON inventory_entries(holding_id, occurred_at);
