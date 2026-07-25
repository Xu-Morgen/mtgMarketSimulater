-- I11B：补充包配置与可重放开包随机性审计。MVP 不保存保底/计数器状态。
CREATE TABLE booster_packs (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  price_amount INTEGER NOT NULL CHECK (price_amount >= 0),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  disabled_reason TEXT,
  active_rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((enabled = 1 AND disabled_reason IS NULL) OR (enabled = 0 AND disabled_reason IS NOT NULL))
);

-- definition_json 是完整不可变规则快照，包含卡位、候选池与整数权重。
CREATE TABLE booster_pack_rules (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES booster_packs(id),
  version TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  UNIQUE(pack_id, version)
);
CREATE INDEX booster_pack_rules_pack_index ON booster_pack_rules(pack_id, created_at DESC);

-- 随机种子仅留在服务端 SQLite；不存在读取 HTTP 路由，结果摘要用于审计与规则重放。
CREATE TABLE pack_rule_replays (
  id TEXT PRIMARY KEY,
  pack_id TEXT NOT NULL REFERENCES booster_packs(id),
  pack_rule_id TEXT NOT NULL REFERENCES booster_pack_rules(id),
  random_seed TEXT NOT NULL,
  random_seed_hash TEXT NOT NULL,
  result_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX pack_rule_replays_pack_created_index ON pack_rule_replays(pack_id, created_at DESC);
