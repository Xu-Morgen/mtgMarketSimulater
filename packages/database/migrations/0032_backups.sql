-- I31B SQLite 一致性备份记录。备份由 backup.create 任务在事务外用 better-sqlite3 .backup() 产出
-- WAL 一致副本；此表只追加备份事实，绝不写经济真相。失败只追加 failed 记录，绝不删除最近成功备份。
-- 保留策略由 application 读取 succeeded 记录后清理多余磁盘文件；文件路径相对 BACKUP_DIR，不下发绝对路径给浏览器。
CREATE TABLE IF NOT EXISTS backup_records (
  id TEXT PRIMARY KEY,
  -- scheduled=每日自动；manual=管理员触发；predeploy=部署前自动触发。
  kind TEXT NOT NULL CHECK (kind IN ('scheduled', 'manual', 'predeploy')),
  -- running 进行中；succeeded 成功（已过完整性校验）；failed 失败（保留最近成功备份）。
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  -- 运行时配置的源库路径，仅审计用途，不对外暴露。
  source_sqlite_path TEXT NOT NULL,
  -- 落盘文件名与相对 BACKUP_DIR 的路径（浏览器只看到文件名 + 受控下载流）。
  backup_file_name TEXT,
  backup_path_relative TEXT,
  size_bytes INTEGER,
  -- 备份库的 PRAGMA integrity_check 结果（0/1）。
  sqlite_integrity_ok INTEGER CHECK (sqlite_integrity_ok IN (0, 1)),
  sha256 TEXT,
  failure_reason TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  -- 任务/请求溯源，与审计一致。
  request_id TEXT,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS backup_records_kind_status_index ON backup_records(kind, status);
CREATE INDEX IF NOT EXISTS backup_records_created_index ON backup_records(created_at DESC);
CREATE INDEX IF NOT EXISTS backup_records_idempotency_index ON backup_records(idempotency_key);

-- 每日备份调度进度单例，与 backup_records 解耦。
-- 以 UTC 自然日为唯一键投递 backup.create：同一天只投递一次，停机多日只补一次而非逐日补投。
CREATE TABLE IF NOT EXISTS backup_schedule_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  -- 已为其投递过 backup.create 的 UTC 自然日 YYYY-MM-DD。
  last_scheduled_date TEXT NOT NULL,
  -- 最近一次投递的 run_after ISO 时间戳，用于审计与排障。
  last_attempted_run_after TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO backup_schedule_state (singleton, last_scheduled_date, last_attempted_run_after, updated_at)
VALUES (1, '1970-01-01', '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z')
ON CONFLICT(singleton) DO NOTHING;
