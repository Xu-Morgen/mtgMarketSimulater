-- I33B（C6）：特殊补充包限时销售窗口。
-- 有 offer 的包只在该窗口内以折扣价可购买；窗口外（未开始/已结束）与下架同语义拒绝购买，
-- 普通无 offer 包不受影响。offer 是纯销售配置，不改变 booster_pack_rules 的不可变规则版本；
-- 主题包的限定卡池/概率覆盖仍由 booster_pack_rules 不可变版本承载。
CREATE TABLE pack_offers (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES booster_packs(id),
  name TEXT NOT NULL,
  description TEXT,
  -- 10_000 = 无折扣；窗口内实际售价 = booster_packs.price_amount × discount_bps ÷ 10_000（整数向下取整）。
  discount_bps INTEGER NOT NULL CHECK (discount_bps >= 1 AND discount_bps <= 10000),
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('scheduled','active','ended')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX pack_offers_pack_index ON pack_offers(pack_id, created_at DESC);
-- 同一包同时至多一个未结束的 offer；提前结束用 status='ended'，保留审计历史。
CREATE UNIQUE INDEX pack_offers_pack_active_unique ON pack_offers(pack_id) WHERE status IN ('scheduled','active');
