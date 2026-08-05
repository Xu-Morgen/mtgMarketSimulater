-- I36B：新手引导与首次体验。
-- ① onboarding_steps 固定引导目标链步骤定义（创建存档并领取工作资金 → 开包 → 看价 →
--    首笔 NPC 交易 → 收藏见涨 → 首次报名），与 packages/rules `resolveOnboardingSteps`
--    一一对应；配置以 rule_versions 的 `onboarding/v1` 行版本化发布，进度行记录所依据步骤版本；
-- ② onboarding_progress 每玩家每步骤一行，PRIMARY KEY(user_id, step_id) 收敛并发/重放；
--    完成只由服务端按已结算事实（pack.opened/npc.trade.settled）的同事务幂等消费者推进
--    或按已结算状态（账本/库存/报名表）快照置完成；跳过永久记为已完成（老玩家补完路径）；
-- ③ onboarding_reward_grants 以 PRIMARY KEY(user_id) 保证一次性完成奖励至多发放一次；
-- ④ onboarding_events 记录 view_event 步骤的服务端访问事件，(user_id, event_kind, step_id)
--    唯一约束使重放/重复访问不重复计数。
CREATE TABLE IF NOT EXISTS onboarding_steps (
  id TEXT PRIMARY KEY,
  step_order INTEGER NOT NULL CHECK (step_order >= 1),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  href TEXT NOT NULL,
  target_path TEXT,
  skippable INTEGER NOT NULL CHECK (skippable IN (0, 1)),
  rule_version TEXT NOT NULL
);

INSERT INTO onboarding_steps (id, step_order, title, description, href, target_path, skippable, rule_version) VALUES
  ('claim-work-funds', 1, '领取工作资金', '创建游戏存档并领取今日工作资金，开始你的卡牌交易所之旅', '/dashboard', NULL, 1, 'onboarding/v1'),
  ('open-first-pack', 2, '开出第一包', '在补充包商店购买并开出第一包补充包', '/packs', NULL, 1, 'onboarding/v1'),
  ('view-price-history', 3, '看懂价格', '打开单卡价格历史，查看参考价与游戏内报价的双价格走势', '/market/history', '/market/history', 1, 'onboarding/v1'),
  ('complete-first-npc-trade', 4, '完成首笔交易', '在市场向 NPC 完成你的第一笔卡牌交易', '/market', NULL, 1, 'onboarding/v1'),
  ('unlock-collection-album', 5, '收藏见涨', '打开收藏图鉴，查看已收集卡牌与系列完成度', '/collection/album', NULL, 1, 'onboarding/v1'),
  ('first-tournament-registration', 6, '首次报名', '构筑合法卡组并报名一场比赛', '/tournaments', NULL, 1, 'onboarding/v1')
ON CONFLICT(id) DO NOTHING;

CREATE TABLE IF NOT EXISTS onboarding_progress (
  user_id TEXT NOT NULL REFERENCES users(id),
  step_id TEXT NOT NULL REFERENCES onboarding_steps(id),
  step_version TEXT NOT NULL,
  completed_at TEXT,
  skipped_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, step_id),
  CHECK ((completed_at IS NULL) OR (skipped_at IS NULL))
);
CREATE INDEX IF NOT EXISTS onboarding_progress_user_index ON onboarding_progress(user_id);

CREATE TABLE IF NOT EXISTS onboarding_reward_grants (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  amount INTEGER NOT NULL CHECK (amount > 0),
  rule_version TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS onboarding_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  event_kind TEXT NOT NULL,
  step_id TEXT NOT NULL REFERENCES onboarding_steps(id),
  occurred_at TEXT NOT NULL,
  UNIQUE(user_id, event_kind, step_id)
);

INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES ('onboarding-v1', 'onboarding', 'onboarding/v1', '{"steps":[{"id":"claim-work-funds","title":"领取工作资金","href":"/dashboard","source":"profile","profileKey":"work_funds_claimed","skippable":true},{"id":"open-first-pack","title":"开出第一包","href":"/packs","source":"fact","factEventType":"pack.opened","goal":1,"skippable":true},{"id":"view-price-history","title":"看懂价格","href":"/market/history","targetPath":"/market/history","source":"view_event","skippable":true},{"id":"complete-first-npc-trade","title":"完成首笔交易","href":"/market","source":"fact","factEventType":"npc.trade.settled","goal":1,"skippable":true},{"id":"unlock-collection-album","title":"收藏见涨","href":"/collection/album","source":"profile","profileKey":"collection_has_any","skippable":true},{"id":"first-tournament-registration","title":"首次报名","href":"/tournaments","source":"profile","profileKey":"tournament_registered","skippable":true}],"reward":{"amount":500,"currency":"GAME_CREDIT"}}', '2026-08-05T00:00:00.000Z', NULL)
ON CONFLICT(rule_set, version) DO NOTHING;
