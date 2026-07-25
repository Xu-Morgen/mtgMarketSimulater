-- I12B：已结算开包记录。结果、资金、库存和事实事件必须在同一短事务中追加。
CREATE TABLE pack_openings (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  pack_id TEXT NOT NULL REFERENCES booster_packs(id),
  pack_rule_replay_id TEXT NOT NULL UNIQUE REFERENCES pack_rule_replays(id),
  pack_rule_version TEXT NOT NULL,
  spent_amount INTEGER NOT NULL CHECK (spent_amount >= 0),
  result_summary_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX pack_openings_user_created_index ON pack_openings(user_id, created_at DESC);
CREATE INDEX pack_openings_pack_created_index ON pack_openings(pack_id, created_at DESC);
