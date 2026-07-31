-- I30B 市场参数单例并发版本号；每次更新自增，用于乐观并发检测。
-- 既有单例行初始化为 1。
ALTER TABLE market_parameters ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
UPDATE market_parameters SET version = 1 WHERE singleton = 1;
