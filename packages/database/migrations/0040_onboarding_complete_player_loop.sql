-- I36B/I36F 修复：把新手引导补齐为可完成的核心玩家循环，规则提升为 onboarding/v3。
-- ① 收藏步骤改为实际访问图鉴后完成，不能再由「持有任意库存」代替玩家浏览；
-- ② 把「保存合法 Commander 卡组」拆成独立 profile 步骤，报名不再承担隐含的组卡前置；
-- ③ 把「查看已结算赛果」加入目标链，报名不再被误当作教程终点；
-- ④ 已领取旧版完成奖励的玩家按历史完成处理，新步骤写入 skip 快照，避免升级后重新打开已完成引导。

UPDATE onboarding_steps SET
  step_order = CASE id
    WHEN 'create-archive' THEN 1
    WHEN 'claim-work-funds' THEN 2
    WHEN 'open-first-pack' THEN 3
    WHEN 'view-price-history' THEN 4
    WHEN 'complete-first-npc-trade' THEN 5
    WHEN 'unlock-collection-album' THEN 6
    WHEN 'first-tournament-registration' THEN 8
    ELSE step_order END,
  title = CASE id
    WHEN 'unlock-collection-album' THEN '查看收藏'
    ELSE title END,
  description = CASE id
    WHEN 'first-tournament-registration' THEN '选择刚保存的合法 Commander 卡组，确认报名费用并报名一场比赛'
    ELSE description END,
  target_path = CASE id
    WHEN 'unlock-collection-album' THEN '/collection/album'
    ELSE target_path END,
  rule_version = 'onboarding/v3'
WHERE id IN ('create-archive', 'claim-work-funds', 'open-first-pack', 'view-price-history', 'complete-first-npc-trade', 'unlock-collection-album', 'first-tournament-registration');

INSERT INTO onboarding_steps (id, step_order, title, description, href, target_path, skippable, rule_version) VALUES
  ('create-first-deck', 7, '构筑第一套卡组', '从库存选择一位合法指挥官，用无限虚拟基本地补足 100 张，请求服务端检查并保存合法 Commander 卡组', '/decks', NULL, 1, 'onboarding/v3'),
  ('finish-first-tournament', 9, '查看比赛结果', '等待服务器完成比赛结算，查看排名、胜负、奖励与可公开重放材料', '/tournaments', '/tournaments/result', 1, 'onboarding/v3')
ON CONFLICT(id) DO UPDATE SET
  step_order = excluded.step_order,
  title = excluded.title,
  description = excluded.description,
  href = excluded.href,
  target_path = excluded.target_path,
  skippable = excluded.skippable,
  rule_version = excluded.rule_version;

INSERT INTO onboarding_progress (user_id, step_id, step_version, completed_at, skipped_at, updated_at)
SELECT grant.user_id, step.id, 'onboarding/v3', NULL, grant.claimed_at, grant.claimed_at
FROM onboarding_reward_grants grant
JOIN onboarding_steps step ON step.id IN ('create-first-deck', 'finish-first-tournament')
ON CONFLICT(user_id, step_id) DO NOTHING;

INSERT INTO rule_versions (id, rule_set, version, definition_json, activated_at, retired_at)
VALUES (
  'onboarding-v3',
  'onboarding',
  'onboarding/v3',
  '{"steps":[{"id":"create-archive","title":"创建存档","href":"/dashboard","source":"profile","profileKey":"archive_created","skippable":true},{"id":"claim-work-funds","title":"领取工作资金","href":"/dashboard","source":"profile","profileKey":"work_funds_claimed","skippable":true},{"id":"open-first-pack","title":"开出第一包","href":"/packs","source":"fact","factEventType":"pack.opened","goal":1,"skippable":true},{"id":"view-price-history","title":"看懂价格","href":"/market/history","targetPath":"/market/history","source":"view_event","skippable":true},{"id":"complete-first-npc-trade","title":"完成首笔交易","href":"/market","source":"fact","factEventType":"npc.trade.settled","goal":1,"skippable":true},{"id":"unlock-collection-album","title":"查看收藏","href":"/collection/album","targetPath":"/collection/album","source":"view_event","skippable":true},{"id":"create-first-deck","title":"构筑第一套卡组","href":"/decks","source":"profile","profileKey":"legal_deck_saved","skippable":true},{"id":"first-tournament-registration","title":"首次报名","description":"选择刚保存的合法 Commander 卡组，确认报名费用并报名一场比赛","href":"/tournaments","source":"profile","profileKey":"tournament_registered","skippable":true},{"id":"finish-first-tournament","title":"查看比赛结果","href":"/tournaments","targetPath":"/tournaments/result","source":"view_event","skippable":true}],"reward":{"amount":500,"currency":"GAME_CREDIT"}}',
  '2026-08-06T00:00:00.000Z',
  NULL
)
ON CONFLICT(rule_set, version) DO NOTHING;
