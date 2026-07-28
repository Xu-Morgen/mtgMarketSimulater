-- I20B：P2P 模拟履约状态机。在 bilateral_trades 追加待履约期限列，使撮合成交后能在确定时点
-- 被 order.expire 任务回收为取消履约（不写 p2p.trade.settled）。履约期限沿用委托有效期
-- bilateral_order_limits.ttl_seconds，由撮合时刻起算；旧行没有真实期限，给一个远期占位，
-- 仅供旧数据兼容，不影响新撮合写入的真实期限。履约/取消的状态机迁移与资金/库存/保证金结算
-- 不需要新表，全部在现有 bilateral_trades/fund_holds/inventory_holdings 上以短事务完成。

ALTER TABLE bilateral_trades ADD COLUMN fulfillment_deadline TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z';
-- 按 status + 待履约期限索引，便于运维/排障定位到期成交与扫描（当前 I20B 用投递式触发，
-- 该索引为只读查询与未来批量扫描保留）。
CREATE INDEX IF NOT EXISTS bilateral_trades_status_fulfillment_deadline_index
  ON bilateral_trades(status, fulfillment_deadline);
