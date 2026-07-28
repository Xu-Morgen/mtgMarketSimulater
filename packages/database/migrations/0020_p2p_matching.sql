-- I19B：P2P 双边委托撮合。本期只把已成交部分的买方资金、卖方库存/保证金从「预占」转为
-- 「待履约持有」并写成交记录；不转移最终所有权、不写 p2p.trade.settled、不做履约结算或取消
-- （留 I20B），不做 order.expire 定时回收（留 I22B）。撮合幂等由 idempotency_requests（系统
-- actor）与 bilateral_trades 的唯一约束共同保证：同一对委托在相同成交价下至多落一行成交。

CREATE TABLE IF NOT EXISTS bilateral_trades (
  id TEXT PRIMARY KEY,
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  buy_order_id TEXT NOT NULL REFERENCES bilateral_orders(id),
  sell_order_id TEXT NOT NULL REFERENCES bilateral_orders(id),
  buyer_user_id TEXT NOT NULL REFERENCES users(id),
  seller_user_id TEXT NOT NULL REFERENCES users(id),
  -- 本次成交数量（正整数最小货币单位数量）。
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  -- 取 maker（先入订单簿一方）限价的成交价，整数最小货币单位。
  execution_price_amount INTEGER NOT NULL CHECK (execution_price_amount >= 0),
  -- 买单已成交部分 order_fee；撮合时确认并转入买方待履约资金 hold。
  buyer_fee_amount INTEGER NOT NULL CHECK (buyer_fee_amount >= 0),
  -- 卖单已成交部分 order_fee；撮合时锁定，实际在 I20B 履约时从卖方收入结算。
  seller_fee_amount INTEGER NOT NULL CHECK (seller_fee_amount >= 0),
  -- 买方待履约资金 hold（fund_holds.id，reason='order_fulfillment'）。
  buyer_funds_hold_id TEXT,
  -- 卖方原卖单 inventory_holds.id；撮合时已按已成交数量 capture，库存离开卖方持有。
  seller_inventory_hold_id TEXT,
  -- 卖方已成交部分保证金 hold（fund_holds.id，reason='order_fulfillment_deposit'）。
  seller_deposit_hold_id TEXT,
  -- 卖单已成交数量；卖单剩余 inventory_holds 仍按未成交数量保留供撤单释放。
  seller_inventory_quantity INTEGER NOT NULL CHECK (seller_inventory_quantity >= 0),
  rule_version TEXT NOT NULL,
  -- I19B 只写 matched_pending_fulfillment；fulfilled/cancelled 留 I20B。
  status TEXT NOT NULL CHECK (status IN ('matched_pending_fulfillment', 'fulfilled', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 撮合幂等：同一对委托 + 同一成交价至多一行成交，防并发或重放重复成交。
  UNIQUE(buy_order_id, sell_order_id, execution_price_amount),
  CHECK (buyer_user_id <> seller_user_id)
);
-- 成交记录按 SKU/时间与关联委托/用户检索。
CREATE INDEX IF NOT EXISTS bilateral_trades_sku_created_index
  ON bilateral_trades(sku_id, created_at);
CREATE INDEX IF NOT EXISTS bilateral_trades_buy_order_index
  ON bilateral_trades(buy_order_id);
CREATE INDEX IF NOT EXISTS bilateral_trades_sell_order_index
  ON bilateral_trades(sell_order_id);
CREATE INDEX IF NOT EXISTS bilateral_trades_buyer_user_index
  ON bilateral_trades(buyer_user_id, created_at);
CREATE INDEX IF NOT EXISTS bilateral_trades_seller_user_index
  ON bilateral_trades(seller_user_id, created_at);
