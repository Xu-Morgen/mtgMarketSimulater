-- I30B 管理后台活动草稿与状态机。
-- 草稿在 admin_campaigns 中演进；每次保存/预览/发布追加不可变的 admin_campaign_versions 快照，
-- 已发布版本不可原地覆盖。发布时把校验通过的草稿写入只追加的 market_events，并以活动版本唯一键投递 market.reprice。
CREATE TABLE IF NOT EXISTS admin_campaigns (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  -- 首发仅 market_factor：把 factor_bps 作为供需系数叠加到 market_events。
  campaign_type TEXT NOT NULL CHECK (campaign_type IN ('market_factor')),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'set', 'sku')),
  scope_id TEXT,
  factor_bps INTEGER NOT NULL CHECK (factor_bps BETWEEN 5000 AND 20000),
  display_text TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL CHECK (ends_at > starts_at),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'previewing', 'published', 'paused', 'ended')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  -- 发布后指向由该活动生成的 market_events.id；暂停/结束只改状态，不删该事件。
  published_market_event_id TEXT,
  reason TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  paused_at TEXT,
  ended_at TEXT,
  CHECK ((scope_type = 'global' AND scope_id IS NULL) OR (scope_type IN ('set', 'sku') AND scope_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS admin_campaigns_status_index ON admin_campaigns(status);
CREATE INDEX IF NOT EXISTS admin_campaigns_scope_window_index ON admin_campaigns(scope_type, scope_id, starts_at, ends_at);

-- 不可变的活动版本快照：草稿保存、预览与发布均追加一行，保证已发布版本不可原地覆盖。
CREATE TABLE IF NOT EXISTS admin_campaign_versions (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES admin_campaigns(id),
  version INTEGER NOT NULL CHECK (version >= 1),
  -- 发生该版本时的完整定义快照（类型/范围/系数/区间/文案/原因）。
  definition_json TEXT NOT NULL,
  status_snapshot TEXT NOT NULL CHECK (status_snapshot IN ('draft', 'previewing', 'published', 'paused', 'ended')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(campaign_id, version)
);
CREATE INDEX IF NOT EXISTS admin_campaign_versions_campaign_index ON admin_campaign_versions(campaign_id, version);

-- MTGJSON 系列/密封产品/booster 导入草稿。只允许后台任务下载并校验，绝不直接改写目录、库存或价格快照。
-- 草稿必须以本地 Scryfall 系列代码和 SKU 映射为准；缺失/冲突不可发布。
CREATE TABLE IF NOT EXISTS mtgjson_import_drafts (
  id TEXT PRIMARY KEY,
  draft_kind TEXT NOT NULL CHECK (draft_kind IN ('setlist', 'set', 'sealed_product', 'booster')),
  -- MTGJSON 来源版本（meta.date 或文件版本）与 SHA-256，失败时保留最近成功草稿。
  source_version TEXT NOT NULL,
  source_checksum_sha256 TEXT,
  set_code TEXT,
  -- 草稿原始与映射后载荷；不含密钥或外部 Provider 原始响应。
  payload_json TEXT NOT NULL,
  mapping_status TEXT NOT NULL DEFAULT 'pending' CHECK (mapping_status IN ('pending', 'mapped', 'missing', 'conflict')),
  mapping_summary_json TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'validated', 'published', 'discarded')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- 同一来源版本的同类型草稿只保留一份，重放返回首次结果。
  UNIQUE(draft_kind, set_code, source_version)
);
CREATE INDEX IF NOT EXISTS mtgjson_import_drafts_status_index ON mtgjson_import_drafts(status);
CREATE INDEX IF NOT EXISTS mtgjson_import_drafts_kind_set_index ON mtgjson_import_drafts(draft_kind, set_code);
