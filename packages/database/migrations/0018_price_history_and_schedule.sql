-- I17B：区分日常同步与一次性历史回填运行；旧行默认 daily 保持兼容。
ALTER TABLE price_sync_runs ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'daily'
  CHECK (run_kind IN ('daily', 'backfill'));

-- 每日同步进度单例；与 price_sync_state（最近成功运行指针）解耦。
-- 补跑/重跑以自然日唯一键收敛：同一天只投递一次 prices.sync，停机多日只补一次而非每天补一次。
CREATE TABLE IF NOT EXISTS price_sync_schedule_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  -- 已为其投递过 prices.sync 的 UTC 自然日 YYYY-MM-DD。
  last_scheduled_date TEXT NOT NULL,
  -- 最近一次投递的 run_after ISO 时间戳，用于审计与排障。
  last_attempted_run_after TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO price_sync_schedule_state (singleton, last_scheduled_date, last_attempted_run_after, updated_at)
VALUES (1, '1970-01-01', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
ON CONFLICT(singleton) DO NOTHING;
