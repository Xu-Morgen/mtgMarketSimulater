ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE jobs ADD COLUMN unique_key TEXT NOT NULL DEFAULT '';
ALTER TABLE jobs ADD COLUMN locked_until TEXT;
ALTER TABLE jobs ADD COLUMN last_error TEXT;
UPDATE jobs SET unique_key = id WHERE unique_key = '';
CREATE UNIQUE INDEX IF NOT EXISTS jobs_type_unique_key_unique ON jobs(type, unique_key);
