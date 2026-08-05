-- I35B：留存钩子与成长线。
-- ① task_definitions 固定每日/每周任务定义（开包、交易、收藏价值、参赛、系列完成度），
--    与 packages/rules `resolveDailyTaskDefinitions` 一一对应；周期 reset 以新 period_key
--    产生新实例，旧实例只读保留，不删不重置；
-- ② task_instances 每玩家每定义每周期一行，(user_id, definition_id, period_key) 唯一约束
--    收敛并发/重放推进；进度只由已结算事实（pack.opened/npc.trade.settled/
--    p2p.trade.settled/tournament.settled）的同事务幂等消费者推进，重放不重复计数；
-- ③ player_growth 等级/声望快照：total_xp/level 只升不降，净资产峰值只增不减；
--    settled_trades 不落库（由 npc_trades/已履约 bilateral_trades 表直接聚合）。
CREATE TABLE IF NOT EXISTS task_definitions (
  id TEXT PRIMARY KEY,
  period TEXT NOT NULL CHECK (period IN ('daily', 'weekly')),
  metric_type TEXT NOT NULL CHECK (metric_type IN ('pack.open', 'trade', 'npc.sell', 'collection.value', 'tournament.play', 'set.completion')),
  target_amount INTEGER NOT NULL CHECK (target_amount > 0),
  reward_amount INTEGER NOT NULL CHECK (reward_amount > 0),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL
);

INSERT INTO task_definitions (id, period, metric_type, target_amount, reward_amount, title, description, rule_version, created_at) VALUES
  ('daily-open-3/v1', 'daily', 'pack.open', 3, 100, '每日开包', '本日开包 3 次', 'daily-task/v1', '2026-08-05T00:00:00.000Z'),
  ('daily-trade-10/v1', 'daily', 'trade', 10, 100, '每日交易', '本日完成 10 张卡牌交易（NPC 或玩家间）', 'daily-task/v1', '2026-08-05T00:00:00.000Z'),
  ('daily-sell-1/v1', 'daily', 'npc.sell', 1, 80, '每日卖出', '本日向 NPC 卖出至少一张卡牌', 'daily-task/v1', '2026-08-05T00:00:00.000Z'),
  ('daily-collection-2000/v1', 'daily', 'collection.value', 2000, 120, '收藏价值目标', '本日持仓价值达到 2000 游戏币', 'daily-task/v1', '2026-08-05T00:00:00.000Z'),
  ('weekly-tournament-3/v1', 'weekly', 'tournament.play', 3, 300, '每周参赛', '本周完成 3 场赛事结算', 'daily-task/v1', '2026-08-05T00:00:00.000Z'),
  ('weekly-set-80/v1', 'weekly', 'set.completion', 8000, 500, '每周收集', '本周任一系列收集完成度达到 80%', 'daily-task/v1', '2026-08-05T00:00:00.000Z')
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS task_instances (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  definition_id TEXT NOT NULL REFERENCES task_definitions(id),
  period_key TEXT NOT NULL,
  current_value INTEGER NOT NULL CHECK (current_value >= 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'claimable', 'claimed')),
  claimed_at TEXT,
  claimed_idempotency_key TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, definition_id, period_key)
);
CREATE INDEX IF NOT EXISTS task_instances_user_period_index ON task_instances(user_id, period_key, status);

CREATE TABLE IF NOT EXISTS player_growth (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  total_xp INTEGER NOT NULL CHECK (total_xp >= 0),
  level INTEGER NOT NULL CHECK (level >= 1),
  title TEXT NOT NULL,
  peak_net_worth_amount INTEGER NOT NULL CHECK (peak_net_worth_amount >= 0),
  rule_version TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES ('daily-task-v1', 'daily-task', 'daily-task/v1', '{"periods":["daily","weekly"],"metricTypes":["pack.open","trade","npc.sell","collection.value","tournament.play","set.completion"],"definitions":[{"id":"daily-open-3/v1","period":"daily","metricType":"pack.open","targetAmount":3,"rewardAmount":100},{"id":"daily-trade-10/v1","period":"daily","metricType":"trade","targetAmount":10,"rewardAmount":100},{"id":"daily-sell-1/v1","period":"daily","metricType":"npc.sell","targetAmount":1,"rewardAmount":80},{"id":"daily-collection-2000/v1","period":"daily","metricType":"collection.value","targetAmount":2000,"rewardAmount":120},{"id":"weekly-tournament-3/v1","period":"weekly","metricType":"tournament.play","targetAmount":3,"rewardAmount":300},{"id":"weekly-set-80/v1","period":"weekly","metricType":"set.completion","targetAmount":8000,"rewardAmount":500}]}', '2026-08-05T00:00:00.000Z', NULL)
ON CONFLICT(rule_set, version) DO NOTHING;

INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES ('level-v1', 'level', 'level/v1', '{"maxLevel":5,"xpThresholds":[0,200,500,1000,2000],"capabilities":{"1":{"npcDailyTradeMultiplier":1,"bulkPackMax":10},"2":{"npcDailyTradeMultiplier":1,"bulkPackMax":50},"3":{"npcDailyTradeMultiplier":2,"bulkPackMax":100},"4":{"npcDailyTradeMultiplier":3,"bulkPackMax":100},"5":{"npcDailyTradeMultiplier":5,"bulkPackMax":100}},"levelUpRewards":{"2":200,"3":300,"4":500,"5":1000}}', '2026-08-05T00:00:00.000Z', NULL)
ON CONFLICT(rule_set, version) DO NOTHING;
