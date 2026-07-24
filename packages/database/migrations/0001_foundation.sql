CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'player',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), refresh_token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_index ON sessions(user_id);
CREATE TABLE IF NOT EXISTS idempotency_requests (
  id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL, status TEXT NOT NULL, response_status INTEGER,
  response_json TEXT, created_at TEXT NOT NULL, completed_at TEXT,
  UNIQUE(actor_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), currency TEXT NOT NULL,
  total_amount INTEGER NOT NULL CHECK (total_amount >= 0),
  available_amount INTEGER NOT NULL CHECK (available_amount >= 0),
  frozen_amount INTEGER NOT NULL CHECK (frozen_amount >= 0), updated_at TEXT NOT NULL,
  CHECK (total_amount = available_amount + frozen_amount), UNIQUE(user_id, currency)
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), direction TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0), balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
  reason TEXT NOT NULL, correlation_id TEXT NOT NULL, occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_entries_account_occurred_index ON ledger_entries(account_id, occurred_at);
CREATE TABLE IF NOT EXISTS fund_holds (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), amount INTEGER NOT NULL CHECK (amount > 0),
  reason TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, released_at TEXT
);
CREATE INDEX IF NOT EXISTS fund_holds_account_status_index ON fund_holds(account_id, status);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL, request_id TEXT, summary_json TEXT NOT NULL, occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_logs_entity_index ON audit_logs(entity_type, entity_id);
CREATE TABLE IF NOT EXISTS fact_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  version INTEGER NOT NULL, payload_json TEXT NOT NULL, occurred_at TEXT NOT NULL,
  UNIQUE(aggregate_type, aggregate_id, version)
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES fact_events(id), destination TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, dispatched_at TEXT,
  UNIQUE(event_id, destination)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', run_after TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rule_versions (
  id TEXT PRIMARY KEY, rule_set TEXT NOT NULL, version TEXT NOT NULL, definition_json TEXT NOT NULL,
  activated_at TEXT NOT NULL, retired_at TEXT, UNIQUE(rule_set, version)
);
