ALTER TABLE sessions ADD COLUMN csrf_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN rotated_from_session_id TEXT REFERENCES sessions(id);
CREATE INDEX IF NOT EXISTS sessions_refresh_token_hash_index ON sessions(refresh_token_hash);
