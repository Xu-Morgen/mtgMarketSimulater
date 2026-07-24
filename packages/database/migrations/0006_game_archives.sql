CREATE TABLE IF NOT EXISTS game_archives (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  initial_funding_rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS game_archives_user_id_index ON game_archives(user_id);

-- 初始资金规则与其资金流水一起保存，后续规则版本切换不会改写既有存档的起点。
INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES (
  'initial-funds-v1',
  'initial-funds',
  'v1',
  '{"currency":"GAME_CREDIT","amount":10000}',
  '2026-07-24T00:00:00.000Z',
  NULL
)
ON CONFLICT(rule_set, version) DO NOTHING;
