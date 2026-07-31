-- I30B 用户冻结/解冻：users 表新增可空的冻结时间与原因，frozen_at IS NULL 表示活跃。
-- 会话撤销复用既有 sessions.revoked_at（admin 批量撤销该用户未撤销会话），无需新增列。
ALTER TABLE users ADD COLUMN frozen_at TEXT;
ALTER TABLE users ADD COLUMN frozen_reason TEXT;
CREATE INDEX IF NOT EXISTS users_frozen_index ON users(frozen_at);
