-- I33B：系列收集率里程碑成就（扩展 I26B 成就系统）。
-- 按「收集某系列 80%/100% 的该系列印刷 SKU 总数」自动解锁，奖励沿用既有成就配置（GAME_CREDIT/徽章），
-- 复用 achievement_progress/achievement_unlocks/achievement_reward_grants 的幂等与不可变审计链路。
-- 完成度由服务端按 card_skus 全量（含该系列全部印刷×工艺 SKU）与玩家库存持有（quantity > 0）聚合，
-- 由 achievement 消费 pack.opened fact 的处理器推进；definition_id 与 rules 固定 id 一一对应。
INSERT INTO achievement_definitions (id, kind, category, goal, reward_kind, reward_amount, reward_pack_id, reward_sku_id, reward_badge_id, title, description, badge, hidden, rule_version, created_at) VALUES
  ('set-completion-80/v1', 'collection', 'collection-set', 80, 'GAME_CREDIT', 300, NULL, NULL, NULL, '系列图鉴·八成', '任意一个系列的收集率达到 80%', NULL, 0, 'achievement/v1', '2026-08-04T00:00:00.000Z'),
  ('set-completion-100/v1', 'collection', 'collection-set', 100, 'badge', 0, NULL, NULL, 'set-completion-100', '系列图鉴·圆满', '任意一个系列的收集率达到 100%', 'set-completion-100', 0, 'achievement/v1', '2026-08-04T00:00:00.000Z');
