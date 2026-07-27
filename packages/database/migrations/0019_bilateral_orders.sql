-- I18B：P2P 双边委托预览与订单创建。撮合、模拟履约、p2p.trade.settled 与 order.expire
-- 定时任务均延后至 I19B/I20B；本期只持久化委托、预占/释放与只读订单簿。
CREATE TABLE IF NOT EXISTS bilateral_order_limits (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  -- 单笔委托的最大数量；与单日额度共同防止刷单。
  max_quantity_per_order INTEGER NOT NULL CHECK (max_quantity_per_order > 0),
  -- 单用户/SKU/UTC 自然日的最大委托数量，由已结算 bilateral_orders 聚合。
  max_quantity_per_user_sku_day INTEGER NOT NULL CHECK (max_quantity_per_user_sku_day > 0),
  -- 限价带宽度（bp）：以 market_quotes.market_price 为中心上下浮动，10_000 = 1:1 不浮动。
  limit_price_band_bps INTEGER NOT NULL CHECK (limit_price_band_bps BETWEEN 0 AND 100000),
  -- 订单手续费率（bp），针对成交金额计算。
  order_fee_bps INTEGER NOT NULL CHECK (order_fee_bps BETWEEN 0 AND 100000),
  -- 模拟履约保证金率（bp），针对成交金额计算；卖单创建时按全额预占，履约/取消时结算。
  fulfillment_deposit_bps INTEGER NOT NULL CHECK (fulfillment_deposit_bps BETWEEN 0 AND 100000),
  -- 委托有效期（秒）；过期由 order.expire 任务回收，不在本期实现定时任务。
  ttl_seconds INTEGER NOT NULL CHECK (ttl_seconds > 0),
  updated_at TEXT NOT NULL
);
INSERT INTO bilateral_order_limits (singleton, max_quantity_per_order, max_quantity_per_user_sku_day, limit_price_band_bps, order_fee_bps, fulfillment_deposit_bps, ttl_seconds, updated_at)
VALUES (1, 20, 100, 5000, 200, 1000, 86400, '2026-07-27T00:00:00.000Z')
ON CONFLICT(singleton) DO NOTHING;

CREATE TABLE IF NOT EXISTS bilateral_orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  sku_id TEXT NOT NULL REFERENCES card_skus(id),
  side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  status TEXT NOT NULL CHECK (status IN ('open', 'partially_filled', 'matched_pending_fulfillment', 'fulfilled', 'cancelled', 'expired')),
  original_quantity INTEGER NOT NULL CHECK (original_quantity > 0),
  remaining_quantity INTEGER NOT NULL CHECK (remaining_quantity >= 0),
  -- 玩家在预览带内确认的单位限价（整数最小货币单位）。
  limit_price_amount INTEGER NOT NULL CHECK (limit_price_amount >= 0),
  -- 服务端按规则计算的单位手续费（展示用，订单阶段未实际预占）。
  unit_fee_amount INTEGER NOT NULL CHECK (unit_fee_amount >= 0),
  -- 服务端按规则计算的卖单单位保证金（展示用，卖单全额预占）。
  unit_fulfillment_deposit_amount INTEGER NOT NULL CHECK (unit_fulfillment_deposit_amount >= 0),
  -- 当前实际预占的资金金额：买单=剩余数量*限价+剩余手续费；卖单=剩余数量*保证金。
  reserved_funds_amount INTEGER NOT NULL CHECK (reserved_funds_amount >= 0),
  -- fund_holds.id；撤单释放该 hold。
  reserved_funds_hold_id TEXT,
  -- inventory_holds.id；仅卖单创建时写入，撤单释放该 hold。
  inventory_hold_id TEXT,
  -- 引用创建时不可变报价快照；撮合/履约仍以规则版本校验。
  quote_id TEXT NOT NULL REFERENCES market_quotes(id),
  quote_version TEXT NOT NULL,
  -- 服务端预览版本：预览过期或限价/报价变化时必须重新获取，防止客户端按旧值结算。
  preview_version TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  cancelled_at TEXT,
  -- 乐观并发与状态机版本；每次状态迁移 +1。
  version INTEGER NOT NULL CHECK (version >= 1),
  -- 创建时的 UTC 自然日，用于聚合单日额度。
  settlement_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (remaining_quantity <= original_quantity),
  CHECK (status IN ('open', 'partially_filled') OR remaining_quantity = 0 OR status IN ('cancelled', 'expired'))
);
-- 我的委托分页与单日额度聚合。
CREATE INDEX IF NOT EXISTS bilateral_orders_user_created_index
  ON bilateral_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bilateral_orders_user_sku_side_day_index
  ON bilateral_orders(user_id, sku_id, side, settlement_date);
-- 只读订单簿：按 SKU/side 与价格-时间优先聚合。
CREATE INDEX IF NOT EXISTS bilateral_orders_book_index
  ON bilateral_orders(sku_id, side, status, limit_price_amount, created_at);
