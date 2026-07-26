-- 基础补充包商品。候选 SKU 只能在服务端目录同步完成后生成，避免把外部目录 UUID 写死在迁移中。
-- bootstrap 规则仅用于在目录缺失时安全公示卡位；两个商品会保持停用，直到 catalog.sync 原子发布对应系列的规则快照。
INSERT INTO booster_packs (
  id, code, name, description, price_amount, enabled, disabled_reason, active_rule_version, created_at, updated_at
) VALUES
  (
    '13000000-0000-4000-8000-000000000001',
    'BRO-BASE',
    '兄弟之战基础补充包',
    '仅从 BRO（The Brothers'' War）目录中产出非闪卡。',
    500,
    0,
    '等待 BRO 目录同步',
    'base/bro/bootstrap',
    '2026-07-26T00:00:00.000Z',
    '2026-07-26T00:00:00.000Z'
  ),
  (
    '13000000-0000-4000-8000-000000000002',
    'SOS-BASE',
    '斯翠海文秘闻基础补充包',
    '仅从 SOS（Secrets of Strixhaven）目录中产出非闪卡。',
    500,
    0,
    '等待 SOS 目录同步',
    'base/sos/bootstrap',
    '2026-07-26T00:00:00.000Z',
    '2026-07-26T00:00:00.000Z'
  );

INSERT INTO booster_pack_rules (id, pack_id, version, definition_json, created_at, retired_at) VALUES
  (
    '14000000-0000-4000-8000-000000000001',
    '13000000-0000-4000-8000-000000000001',
    'base/bro/bootstrap',
    '{"version":"base/bro/bootstrap","pools":[{"id":"common","rarity":"common","candidates":[{"skuId":"bootstrap-bro-common","weight":1}]},{"id":"uncommon","rarity":"uncommon","candidates":[{"skuId":"bootstrap-bro-uncommon","weight":1}]},{"id":"rare","rarity":"rare","candidates":[{"skuId":"bootstrap-bro-rare","weight":1}]},{"id":"mythic","rarity":"mythic","candidates":[{"skuId":"bootstrap-bro-mythic","weight":1}]}],"slots":[{"id":"common","draws":10,"poolWeights":[{"poolId":"common","weight":1}]},{"id":"uncommon","draws":3,"poolWeights":[{"poolId":"uncommon","weight":1}]},{"id":"rare","draws":1,"poolWeights":[{"poolId":"rare","weight":7},{"poolId":"mythic","weight":1}]}]}',
    '2026-07-26T00:00:00.000Z',
    NULL
  ),
  (
    '14000000-0000-4000-8000-000000000002',
    '13000000-0000-4000-8000-000000000002',
    'base/sos/bootstrap',
    '{"version":"base/sos/bootstrap","pools":[{"id":"common","rarity":"common","candidates":[{"skuId":"bootstrap-sos-common","weight":1}]},{"id":"uncommon","rarity":"uncommon","candidates":[{"skuId":"bootstrap-sos-uncommon","weight":1}]},{"id":"rare","rarity":"rare","candidates":[{"skuId":"bootstrap-sos-rare","weight":1}]},{"id":"mythic","rarity":"mythic","candidates":[{"skuId":"bootstrap-sos-mythic","weight":1}]}],"slots":[{"id":"common","draws":10,"poolWeights":[{"poolId":"common","weight":1}]},{"id":"uncommon","draws":3,"poolWeights":[{"poolId":"uncommon","weight":1}]},{"id":"rare","draws":1,"poolWeights":[{"poolId":"rare","weight":7},{"poolId":"mythic","weight":1}]}]}',
    '2026-07-26T00:00:00.000Z',
    NULL
  );
