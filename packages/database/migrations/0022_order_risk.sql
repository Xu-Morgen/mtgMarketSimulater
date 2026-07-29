-- I21B：订单风控配置与不可变决策记录。风控只拦截/标记请求，绝不直接修改余额、库存或订单资产。
CREATE TABLE IF NOT EXISTS bilateral_order_risk_limits (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  order_cooldown_seconds INTEGER NOT NULL CHECK (order_cooldown_seconds >= 0),
  max_orders_per_window INTEGER NOT NULL CHECK (max_orders_per_window > 0),
  order_window_seconds INTEGER NOT NULL CHECK (order_window_seconds > 0),
  max_cancellations_per_window INTEGER NOT NULL CHECK (max_cancellations_per_window > 0),
  cancellation_window_seconds INTEGER NOT NULL CHECK (cancellation_window_seconds > 0),
  review_score_threshold INTEGER NOT NULL CHECK (review_score_threshold > 0),
  updated_at TEXT NOT NULL
);
INSERT INTO bilateral_order_risk_limits (singleton, order_cooldown_seconds, max_orders_per_window, order_window_seconds, max_cancellations_per_window, cancellation_window_seconds, review_score_threshold, updated_at)
VALUES (1, 5, 5, 60, 3, 300, 60, '2026-07-29T00:00:00.000Z')
ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS order_risk_decisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  order_id TEXT REFERENCES bilateral_orders(id),
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  action TEXT NOT NULL CHECK (action IN ('create', 'cancel', 'match')),
  outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'blocked', 'flagged')),
  score INTEGER NOT NULL CHECK (score >= 0),
  reasons_json TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  request_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS order_risk_decisions_review_index
  ON order_risk_decisions(outcome, score DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS order_risk_decisions_user_created_index
  ON order_risk_decisions(user_id, created_at DESC);
