CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  attempt INTEGER NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  error_summary TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS job_runs_job_attempt_unique ON job_runs(job_id, attempt);
CREATE INDEX IF NOT EXISTS job_runs_job_started_index ON job_runs(job_id, started_at DESC);
