-- I23B：日切只开放资格，领取命令才在用户+自然日唯一约束下入账。
-- 规则、金额与时区在开放日快照，配置变更不会改写当天或历史领取。
CREATE TABLE IF NOT EXISTS daily_rollover_runs (
  id TEXT PRIMARY KEY,
  natural_date TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL,
  work_funding_rule_version TEXT NOT NULL,
  work_funding_amount INTEGER NOT NULL CHECK (work_funding_amount > 0),
  opened_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS daily_rollover_runs_opened_at_index ON daily_rollover_runs(opened_at);

CREATE TABLE IF NOT EXISTS daily_work_funding_claims (
  id TEXT PRIMARY KEY,
  rollover_id TEXT NOT NULL REFERENCES daily_rollover_runs(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  natural_date TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  idempotency_key TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  UNIQUE(user_id, natural_date),
  UNIQUE(user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS daily_work_funding_claims_user_claimed_index ON daily_work_funding_claims(user_id, claimed_at DESC);

INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES (
  'daily-work-funds-v1',
  'daily-work-funds',
  'daily-work-funds/v1',
  '{"currency":"GAME_CREDIT","amount":1000}',
  '2026-07-29T00:00:00.000Z',
  NULL
)
ON CONFLICT(rule_set, version) DO NOTHING;

INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES (
  'daily-work-funds-v2',
  'daily-work-funds',
  'daily-work-funds/v2',
  '{"currency":"GAME_CREDIT","amount":1200}',
  '2026-07-29T00:00:00.000Z',
  NULL
)
ON CONFLICT(rule_set, version) DO NOTHING;
