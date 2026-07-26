ALTER TABLE price_sync_runs ADD COLUMN checksum_verification TEXT NOT NULL DEFAULT 'not_verified' CHECK (checksum_verification IN ('verified', 'bypassed', 'not_verified'));
ALTER TABLE price_sync_runs ADD COLUMN failure_code TEXT;

-- 历史成功快照均由原有的强制 checksum 校验路径写入；失败运行不能据此推断校验结果。
UPDATE price_sync_runs SET checksum_verification = 'verified' WHERE status = 'succeeded';
UPDATE price_sync_runs SET failure_code = 'CHECKSUM_MISMATCH' WHERE failure_reason = 'MTGJSON 文件 checksum 不匹配';

-- 同一管理员覆写请求的幂等重放只能留下一个高风险操作审计事实。
CREATE UNIQUE INDEX IF NOT EXISTS audit_logs_price_sync_checksum_bypass_unique
  ON audit_logs(action, entity_id)
  WHERE action = 'price_sync.checksum_bypass_requested';
