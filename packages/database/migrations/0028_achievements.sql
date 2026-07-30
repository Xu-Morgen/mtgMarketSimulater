-- I26B：成就配置、进度、不可变解锁、奖励发放与每日风控计数。
-- 受控成就定义由迁移固定，与 packages/rules resolveFirstAchievements 的 id 一一对应。
CREATE TABLE achievement_definitions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('tournament','deck','collection')),
  category TEXT NOT NULL,
  goal INTEGER NOT NULL CHECK (goal > 0),
  reward_kind TEXT NOT NULL CHECK (reward_kind IN ('GAME_CREDIT','sku','badge')),
  reward_amount INTEGER NOT NULL CHECK (reward_amount >= 0),
  reward_pack_id TEXT,
  reward_sku_id TEXT,
  reward_badge_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  badge TEXT,
  hidden INTEGER NOT NULL CHECK (hidden IN (0,1)),
  rule_version TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (reward_kind = 'GAME_CREDIT' AND reward_amount > 0 AND reward_sku_id IS NULL AND reward_pack_id IS NULL AND reward_badge_id IS NULL)
    OR (reward_kind = 'sku' AND reward_amount = 0 AND reward_sku_id IS NOT NULL AND reward_pack_id IS NULL AND reward_badge_id IS NULL)
    OR (reward_kind = 'badge' AND reward_amount = 0 AND reward_sku_id IS NULL AND reward_pack_id IS NULL AND reward_badge_id IS NOT NULL)
  )
);
INSERT INTO achievement_definitions (id, kind, category, goal, reward_kind, reward_amount, reward_pack_id, reward_sku_id, reward_badge_id, title, description, badge, hidden, rule_version, created_at) VALUES
  ('first-tournament/v1', 'tournament', 'tournament', 1, 'GAME_CREDIT', 200, NULL, NULL, NULL, '初登赛场', '完成你的第一场赛事结算', NULL, 0, 'achievement/v1', '2026-07-30T00:00:00.000Z'),
  ('tournament-champion/v1', 'tournament', 'tournament', 1, 'badge', 0, NULL, NULL, 'tournament-champion', '冠军时刻', '在一场赛事中夺冠（排名第一）', 'tournament-champion', 0, 'achievement/v1', '2026-07-30T00:00:00.000Z'),
  ('win-streak-3/v1', 'tournament', 'tournament', 3, 'GAME_CREDIT', 500, NULL, NULL, NULL, '三连胜', '连续 3 场赛事结算均夺冠', NULL, 0, 'achievement/v1', '2026-07-30T00:00:00.000Z'),
  ('mono-color-commander/v1', 'deck', 'deck', 1, 'badge', 0, NULL, NULL, 'mono-color-commander', '纯粹色系', '使用单色指挥官参赛并夺冠', 'mono-color-commander', 0, 'achievement/v1', '2026-07-30T00:00:00.000Z'),
  ('series-pilot/v1', 'deck', 'deck', 1, 'badge', 0, NULL, NULL, 'series-pilot', '系列先锋', '使用同一系列占主导的卡组参赛并夺冠', 'series-pilot', 1, 'achievement/v1', '2026-07-30T00:00:00.000Z'),
  ('collection-10/v1', 'collection', 'collection', 10, 'GAME_CREDIT', 100, NULL, NULL, NULL, '收藏起步', '持有 10 种不同卡牌 SKU', NULL, 0, 'achievement/v1', '2026-07-30T00:00:00.000Z'),
  ('collection-50/v1', 'collection', 'collection', 50, 'GAME_CREDIT', 500, NULL, NULL, NULL, '收藏进阶', '持有 50 种不同卡牌 SKU', NULL, 0, 'achievement/v1', '2026-07-30T00:00:00.000Z'),
  ('collection-100/v1', 'collection', 'collection', 100, 'GAME_CREDIT', 1000, NULL, NULL, NULL, '收藏家', '持有 100 种不同卡牌 SKU', NULL, 0, 'achievement/v1', '2026-07-30T00:00:00.000Z');

-- 玩家进度（按成就分），唯一约束收敛每次评估只产生一行；已解锁后不再回退。
CREATE TABLE achievement_progress (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  definition_id TEXT NOT NULL REFERENCES achievement_definitions(id),
  current_value INTEGER NOT NULL CHECK (current_value >= 0),
  goal_value INTEGER NOT NULL CHECK (goal_value > 0),
  status TEXT NOT NULL CHECK (status IN ('pending','unlocked')),
  unlocked_at TEXT,
  last_evaluated_fact_id TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, definition_id)
);
CREATE INDEX achievement_progress_user_index ON achievement_progress(user_id);

-- 不可变解锁记录：来源指向触发解锁的 fact 与 aggregate，便于反查赛事/流水；唯一键保证幂等。
CREATE TABLE achievement_unlocks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  definition_id TEXT NOT NULL REFERENCES achievement_definitions(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('tournament.settled','collection')),
  source_fact_id TEXT,
  source_aggregate_id TEXT,
  rule_version TEXT NOT NULL,
  unlocked_at TEXT NOT NULL,
  UNIQUE(user_id, definition_id)
);
CREATE INDEX achievement_unlocks_source_fact_index ON achievement_unlocks(source_fact_id);
CREATE INDEX achievement_unlocks_user_index ON achievement_unlocks(user_id);

-- 奖励发放流水：与解锁同事务写入；correlation_id 关联账本或库存流水，唯一键防止重复发奖。
CREATE TABLE achievement_reward_grants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  definition_id TEXT NOT NULL REFERENCES achievement_definitions(id),
  unlock_id TEXT NOT NULL REFERENCES achievement_unlocks(id),
  reward_kind TEXT NOT NULL CHECK (reward_kind IN ('GAME_CREDIT','sku','badge')),
  reward_amount INTEGER NOT NULL CHECK (reward_amount >= 0),
  reward_sku_id TEXT,
  reward_badge_id TEXT,
  grant_status TEXT NOT NULL CHECK (grant_status IN ('granted','blocked')),
  correlation_id TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  UNIQUE(user_id, definition_id)
);
CREATE INDEX achievement_reward_grants_user_index ON achievement_reward_grants(user_id);

-- 每日奖励/重复参赛风控计数；以自然日唯一键收敛并发与补跑。
CREATE TABLE achievement_risk_counters (
  user_id TEXT NOT NULL REFERENCES users(id),
  natural_date TEXT NOT NULL,
  rewards_granted INTEGER NOT NULL CHECK (rewards_granted >= 0),
  repeat_participations INTEGER NOT NULL CHECK (repeat_participations >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, natural_date)
);

-- 成就系统默认风控阈值单例；管理员完整配置留给 I30B。
CREATE TABLE achievement_risk_limits (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  max_rewards_per_day INTEGER NOT NULL CHECK (max_rewards_per_day > 0),
  max_repeat_participations_per_day INTEGER NOT NULL CHECK (max_repeat_participations_per_day > 0),
  updated_at TEXT NOT NULL
);
INSERT INTO achievement_risk_limits (singleton, max_rewards_per_day, max_repeat_participations_per_day, updated_at) VALUES
  (1, 20, 10, '2026-07-30T00:00:00.000Z');
