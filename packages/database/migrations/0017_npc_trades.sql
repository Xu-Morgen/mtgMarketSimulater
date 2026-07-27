-- I15B：NPC 成交引用不可变报价快照；额度在服务端持久化，浏览器无权提交价格或限额。
CREATE TABLE IF NOT EXISTS npc_trade_limits (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  max_quantity_per_trade INTEGER NOT NULL CHECK (max_quantity_per_trade > 0),
  max_quantity_per_user_sku_day INTEGER NOT NULL CHECK (max_quantity_per_user_sku_day > 0),
  updated_at TEXT NOT NULL
);
INSERT INTO npc_trade_limits (singleton, max_quantity_per_trade, max_quantity_per_user_sku_day, updated_at)
VALUES (1, 20, 100, '2026-07-27T00:00:00.000Z')
ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS npc_trades (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  quote_id TEXT NOT NULL REFERENCES market_quotes(id),
  quote_version TEXT NOT NULL,
  unit_price_amount INTEGER NOT NULL CHECK (unit_price_amount >= 0),
  unit_fee_amount INTEGER NOT NULL CHECK (unit_fee_amount >= 0),
  total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  settlement_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (total_amount = unit_price_amount * quantity)
);
CREATE INDEX IF NOT EXISTS npc_trades_user_sku_day_index
  ON npc_trades(user_id, sku_id, side, settlement_date);
CREATE UNIQUE INDEX IF NOT EXISTS npc_trades_quote_user_created_index
  ON npc_trades(id, quote_id, user_id);
