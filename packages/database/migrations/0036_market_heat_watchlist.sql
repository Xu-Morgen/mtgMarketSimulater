-- I34B：市场行情（热度）与 Watchlist 价格提醒。
-- ① market_parameters 增加可配置的「NPC 做市商倾向」全局因素：npc_bias_bps 默认 10000（中性），
--    仍受市场系数上下限（5000–20000）约束，reprice 时作为 bias 因素写入每个 SKU 的 reason；
-- ② watchlist_items 每玩家每 SKU 去重，目标价/方向/启停只存服务端，命中判定由提醒任务执行；
-- ③ watchlist_alerts 以 (user_id, watchlist_item_id, triggered_quote_id) 唯一约束保证
--    「同一报价至多产生一次提醒」，至多一次通知，提醒失败绝不影响价格与市场。
ALTER TABLE market_parameters ADD COLUMN npc_bias_bps INTEGER NOT NULL DEFAULT 10000 CHECK (npc_bias_bps BETWEEN 5000 AND 20000);
ALTER TABLE market_parameters ADD COLUMN npc_bias_reason TEXT NOT NULL DEFAULT 'NPC 做市商倾向';

CREATE TABLE IF NOT EXISTS watchlist_limits (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  max_items_per_user INTEGER NOT NULL CHECK (max_items_per_user > 0),
  updated_at TEXT NOT NULL
);
INSERT INTO watchlist_limits (singleton, max_items_per_user, updated_at)
VALUES (1, 50, '2026-08-04T00:00:00.000Z')
ON CONFLICT(singleton) DO NOTHING;

INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES ('watchlist-v1', 'watchlist', 'watchlist/v1', '{"maxItemsPerUser":50,"targetTypes":["game_price","reference_price"],"directions":["at_or_below","at_or_above"]}', '2026-08-04T00:00:00.000Z', NULL)
ON CONFLICT(rule_set, version) DO NOTHING;

CREATE TABLE IF NOT EXISTS watchlist_items (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('game_price', 'reference_price')),
  direction TEXT NOT NULL CHECK (direction IN ('at_or_below', 'at_or_above')),
  target_amount INTEGER NOT NULL CHECK (target_amount >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, sku_id)
);
CREATE INDEX IF NOT EXISTS watchlist_items_user_index ON watchlist_items(user_id, enabled, sku_id);

CREATE TABLE IF NOT EXISTS watchlist_alerts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  watchlist_item_id TEXT NOT NULL REFERENCES watchlist_items(id),
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  target_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  target_amount INTEGER NOT NULL,
  triggered_quote_id TEXT NOT NULL REFERENCES market_quotes(id),
  triggered_price INTEGER NOT NULL CHECK (triggered_price >= 0),
  triggered_at TEXT NOT NULL,
  read_at TEXT,
  UNIQUE(user_id, watchlist_item_id, triggered_quote_id)
);
CREATE INDEX IF NOT EXISTS watchlist_alerts_user_created_index ON watchlist_alerts(user_id, triggered_at DESC);
