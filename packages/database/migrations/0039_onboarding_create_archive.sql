-- I36F：新手引导第一步改为「创建存档」，规则版本提升为 onboarding/v2。
-- ① 新增 create-archive 步骤（profile：按 accounts 存档快照判定，满足即完成、只升不降），
--    并把既有六步后移一位（step_order 2–7）；
-- ② 既有进度行按 step_id 关联（onboarding_progress PRIMARY KEY(user_id, step_id)），
--    步骤定义变更只影响新判定，不重置任何已有进度；
-- ③ rule_versions 记录 onboarding/v2（旧 onboarding/v1 行保留供历史进度/发放追溯）。
INSERT INTO onboarding_steps (id, step_order, title, description, href, target_path, skippable, rule_version) VALUES
  ('create-archive', 1, '创建存档', '点击玩家首页「创建游戏存档」按钮，服务器会初始化你的账户和初始资金', '/dashboard', NULL, 1, 'onboarding/v2')
ON CONFLICT(id) DO NOTHING;

UPDATE onboarding_steps SET
  step_order = CASE id
    WHEN 'claim-work-funds' THEN 2
    WHEN 'open-first-pack' THEN 3
    WHEN 'view-price-history' THEN 4
    WHEN 'complete-first-npc-trade' THEN 5
    WHEN 'unlock-collection-album' THEN 6
    WHEN 'first-tournament-registration' THEN 7
    ELSE step_order END,
  description = CASE id
    WHEN 'claim-work-funds' THEN '在玩家首页领取今日工作资金，开始你的卡牌交易所之旅'
    ELSE description END,
  rule_version = 'onboarding/v2'
WHERE id IN ('claim-work-funds', 'open-first-pack', 'view-price-history', 'complete-first-npc-trade', 'unlock-collection-album', 'first-tournament-registration');

INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES ('onboarding-v2', 'onboarding', 'onboarding/v2', '{"steps":[{"id":"create-archive","title":"创建存档","href":"/dashboard","source":"profile","profileKey":"archive_created","skippable":true},{"id":"claim-work-funds","title":"领取工作资金","href":"/dashboard","source":"profile","profileKey":"work_funds_claimed","skippable":true},{"id":"open-first-pack","title":"开出第一包","href":"/packs","source":"fact","factEventType":"pack.opened","goal":1,"skippable":true},{"id":"view-price-history","title":"看懂价格","href":"/market/history","targetPath":"/market/history","source":"view_event","skippable":true},{"id":"complete-first-npc-trade","title":"完成首笔交易","href":"/market","source":"fact","factEventType":"npc.trade.settled","goal":1,"skippable":true},{"id":"unlock-collection-album","title":"收藏见涨","href":"/collection/album","source":"profile","profileKey":"collection_has_any","skippable":true},{"id":"first-tournament-registration","title":"首次报名","href":"/tournaments","source":"profile","profileKey":"tournament_registered","skippable":true}],"reward":{"amount":500,"currency":"GAME_CREDIT"}}', '2026-08-05T00:00:00.000Z', NULL)
ON CONFLICT(rule_set, version) DO NOTHING;
