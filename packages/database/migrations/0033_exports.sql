-- I31B 玩家经营报表导出记录。导出由 ExportApplication 严格按 user_id 过滤生成，写入受控 EXPORT_DIR；
-- 文件路径相对 EXPORT_DIR，浏览器只看到文件名 + 受控下载流，下载时服务端再次复核 ownership 防越权。
CREATE TABLE IF NOT EXISTS export_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  -- 报表范围：all 一次生成全部子报表；后续可扩展单报表。
  kind TEXT NOT NULL DEFAULT 'all' CHECK (kind IN ('all')),
  -- 文件格式：csv 或 json（按 formats 数组逐个落盘）。
  format TEXT NOT NULL CHECK (format IN ('csv', 'json')),
  backup_file_name TEXT NOT NULL,
  file_path_relative TEXT NOT NULL,
  size_bytes INTEGER,
  -- 过期时间；过期文件不可下载并由定时清理删除。
  expires_at TEXT NOT NULL,
  -- running/succeeded/failed/expired。
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed', 'expired')),
  failure_reason TEXT,
  request_id TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(idempotency_key)
);
CREATE INDEX IF NOT EXISTS export_records_user_created_index ON export_records(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS export_records_expires_index ON export_records(expires_at);
