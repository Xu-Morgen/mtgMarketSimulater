import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** SQLite 持久化事实模型。金额字段均为整数最小货币单位，时间均为 UTC ISO 8601。 */
export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("player"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("users_email_unique").on(table.email)]
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    refreshTokenHash: text("refresh_token_hash").notNull(),
    /** 双提交 CSRF token 的摘要；原文只通过非 HttpOnly Cookie 交付浏览器。 */
    csrfTokenHash: text("csrf_token_hash"),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull(),
    /** 轮换链用于 refresh token 重放时撤销其后续派生会话。 */
    rotatedFromSessionId: text("rotated_from_session_id")
  },
  (table) => [index("sessions_user_id_index").on(table.userId)]
);

export const idempotencyRequests = sqliteTable(
  "idempotency_requests",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestFingerprint: text("request_fingerprint").notNull(),
    status: text("status").notNull(),
    responseStatus: integer("response_status"),
    responseJson: text("response_json"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [uniqueIndex("idempotency_actor_key_unique").on(table.actorId, table.idempotencyKey)]
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    currency: text("currency").notNull(),
    totalAmount: integer("total_amount").notNull(),
    availableAmount: integer("available_amount").notNull(),
    frozenAmount: integer("frozen_amount").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("accounts_user_currency_unique").on(table.userId, table.currency)]
);

/** 每位用户唯一的服务端游戏存档；经济起点由关联规则版本与账本共同证明。 */
export const gameArchives = sqliteTable(
  "game_archives",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    initialFundingRuleVersion: text("initial_funding_rule_version").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("game_archives_user_unique").on(table.userId),
    index("game_archives_user_id_index").on(table.userId)
  ]
);

export const ledgerEntries = sqliteTable(
  "ledger_entries",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    direction: text("direction").notNull(),
    amount: integer("amount").notNull(),
    balanceAfter: integer("balance_after").notNull(),
    reason: text("reason").notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [index("ledger_entries_account_occurred_index").on(table.accountId, table.occurredAt)]
);

export const fundHolds = sqliteTable(
  "fund_holds",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    releasedAt: text("released_at")
  },
  (table) => [index("fund_holds_account_status_index").on(table.accountId, table.status)]
);

export const auditLogs = sqliteTable(
  "audit_logs",
  {
    id: text("id").primaryKey(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    requestId: text("request_id"),
    summaryJson: text("summary_json").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [index("audit_logs_entity_index").on(table.entityType, table.entityId)]
);

export const factEvents = sqliteTable(
  "fact_events",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: text("aggregate_id").notNull(),
    version: integer("version").notNull(),
    payloadJson: text("payload_json").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [
    uniqueIndex("fact_events_aggregate_version_unique").on(
      table.aggregateType,
      table.aggregateId,
      table.version
    )
  ]
);

export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => factEvents.id),
    destination: text("destination").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    dispatchedAt: text("dispatched_at")
  },
  (table) => [uniqueIndex("outbox_event_destination_unique").on(table.eventId, table.destination)]
);

export const jobs = sqliteTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status").notNull(),
    runAfter: text("run_after").notNull(),
    attempts: integer("attempts").notNull(),
    maxAttempts: integer("max_attempts").notNull(),
    uniqueKey: text("unique_key").notNull(),
    lockedUntil: text("locked_until"),
    activeRunAttempt: integer("active_run_attempt"),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("jobs_type_unique_key_unique").on(table.type, table.uniqueKey)]
);

/** 每次领取均留下不可变运行记录；重试会创建新的 attempt，而不会覆盖历史错误。 */
export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: text("id").primaryKey(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    attempt: integer("attempt").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    errorSummary: text("error_summary")
  },
  (table) => [
    uniqueIndex("job_runs_job_attempt_unique").on(table.jobId, table.attempt),
    index("job_runs_job_started_index").on(table.jobId, table.startedAt)
  ]
);

export const ruleVersions = sqliteTable(
  "rule_versions",
  {
    id: text("id").primaryKey(),
    ruleSet: text("rule_set").notNull(),
    version: text("version").notNull(),
    definitionJson: text("definition_json").notNull(),
    activatedAt: text("activated_at").notNull(),
    retiredAt: text("retired_at")
  },
  (table) => [uniqueIndex("rule_versions_set_version_unique").on(table.ruleSet, table.version)]
);

/** I08B 目录：印刷与工艺共同决定可交易资产，价格快照不在此层保存。 */
export const cardSets = sqliteTable(
  "card_sets",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    releasedAt: text("released_at"),
    source: text("source").notNull(),
    sourceReference: text("source_reference"),
    createdAt: text("created_at").notNull()
  },
  (table) => [uniqueIndex("card_sets_code_unique").on(table.code)]
);

export const cardPrintings = sqliteTable(
  "card_printings",
  {
    id: text("id").primaryKey(),
    setId: text("set_id")
      .notNull()
      .references(() => cardSets.id),
    name: text("name").notNull(),
    collectorNumber: text("collector_number").notNull(),
    scryfallId: text("scryfall_id"),
    oracleText: text("oracle_text"),
    rarity: text("rarity").notNull(),
    legalitiesJson: text("legalities_json").notNull(),
    artist: text("artist"),
    source: text("source").notNull(),
    sourceReference: text("source_reference"),
    isManualException: integer("is_manual_exception", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("card_printings_set_collector_unique").on(table.setId, table.collectorNumber),
    index("card_printings_name_index").on(table.name)
  ]
);

export const cardSkus = sqliteTable(
  "card_skus",
  {
    id: text("id").primaryKey(),
    printingId: text("printing_id")
      .notNull()
      .references(() => cardPrintings.id),
    finish: text("finish").notNull(),
    tradable: integer("tradable", { mode: "boolean" }).notNull().default(false),
    source: text("source").notNull(),
    sourceReference: text("source_reference"),
    isManualException: integer("is_manual_exception", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("card_skus_printing_finish_unique").on(table.printingId, table.finish),
    index("card_skus_printing_index").on(table.printingId)
  ]
);

export const cardImageCache = sqliteTable(
  "card_image_cache",
  {
    id: text("id").primaryKey(),
    printingId: text("printing_id")
      .notNull()
      .references(() => cardPrintings.id),
    sourceUrl: text("source_url"),
    cachePath: text("cache_path"),
    status: text("status").notNull(),
    checksum: text("checksum"),
    cachedAt: text("cached_at"),
    failureReason: text("failure_reason"),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("card_image_cache_printing_unique").on(table.printingId)]
);

/** I09B：同步运行记录只追加；state 指向最近一次完整、可用的目录版本。 */
export const catalogSyncRuns = sqliteTable(
  "catalog_sync_runs",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    sourceVersion: text("source_version").notNull(),
    sourceUri: text("source_uri").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    enabledSetsJson: text("enabled_sets_json").notNull(),
    status: text("status").notNull(),
    importedPrintings: integer("imported_printings").notNull(),
    importedSkus: integer("imported_skus").notNull(),
    cachedImages: integer("cached_images").notNull(),
    diffJson: text("diff_json").notNull(),
    failureReason: text("failure_reason"),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at")
  },
  (table) => [index("catalog_sync_runs_status_started_index").on(table.status, table.startedAt)]
);

export const catalogSyncState = sqliteTable("catalog_sync_state", {
  singleton: integer("singleton").primaryKey(),
  latestSuccessfulRunId: text("latest_successful_run_id").references(() => catalogSyncRuns.id),
  updatedAt: text("updated_at").notNull()
});

/** I13B：外部价格同步只追加运行、映射与快照；state 仅指向最近完整成功版本。 */
export const priceSyncRuns = sqliteTable(
  "price_sync_runs",
  {
    id: text("id").primaryKey(), source: text("source").notNull(), sourceVersion: text("source_version").notNull(),
    pricesUri: text("prices_uri").notNull(), mappingUri: text("mapping_uri").notNull(), pricesChecksumSha256: text("prices_checksum_sha256").notNull(), mappingChecksumSha256: text("mapping_checksum_sha256").notNull(),
    status: text("status").notNull(), mappedSkus: integer("mapped_skus").notNull(), pricedSkus: integer("priced_skus").notNull(), unpricedSkus: integer("unpriced_skus").notNull(), mappingFailedSkus: integer("mapping_failed_skus").notNull(), failureReason: text("failure_reason"), startedAt: text("started_at").notNull(), completedAt: text("completed_at")
  },
  (table) => [index("price_sync_runs_status_started_index").on(table.status, table.startedAt)]
);

export const priceSyncState = sqliteTable("price_sync_state", { singleton: integer("singleton").primaryKey(), latestSuccessfulRunId: text("latest_successful_run_id").references(() => priceSyncRuns.id), updatedAt: text("updated_at").notNull() });

export const priceSkuMappings = sqliteTable("price_sku_mappings", { id: text("id").primaryKey(), syncRunId: text("sync_run_id").notNull().references(() => priceSyncRuns.id), skuId: text("sku_id").notNull().references(() => cardSkus.id), scryfallId: text("scryfall_id").notNull(), mtgjsonUuid: text("mtgjson_uuid").notNull(), finish: text("finish").notNull(), createdAt: text("created_at").notNull() }, (table) => [uniqueIndex("price_sku_mappings_run_sku_unique").on(table.syncRunId, table.skuId), uniqueIndex("price_sku_mappings_run_uuid_finish_unique").on(table.syncRunId, table.mtgjsonUuid, table.finish), index("price_sku_mappings_sku_index").on(table.skuId, table.createdAt)]);

export const priceSnapshotEntries = sqliteTable("price_snapshot_entries", { id: text("id").primaryKey(), syncRunId: text("sync_run_id").notNull().references(() => priceSyncRuns.id), skuId: text("sku_id").notNull().references(() => cardSkus.id), mappingId: text("mapping_id").references(() => priceSkuMappings.id), mtgjsonUuid: text("mtgjson_uuid"), finish: text("finish").notNull(), priceType: text("price_type").notNull(), currency: text("currency").notNull(), priceAmount: integer("price_amount"), availability: text("availability").notNull(), unavailableReason: text("unavailable_reason"), capturedAt: text("captured_at").notNull(), createdAt: text("created_at").notNull() }, (table) => [uniqueIndex("price_snapshot_entries_run_sku_unique").on(table.syncRunId, table.skuId), index("price_snapshot_entries_sku_captured_index").on(table.skuId, table.capturedAt)]);

/** I10B：库存数量、成本与市值快照；锁定明细与不可变流水见 inventoryHolds / inventoryEntries。 */
export const inventoryHoldings = sqliteTable(
  "inventory_holdings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    skuId: text("sku_id")
      .notNull()
      .references(() => cardSkus.id),
    quantity: integer("quantity").notNull(),
    availableQuantity: integer("available_quantity").notNull(),
    orderLockedQuantity: integer("order_locked_quantity").notNull(),
    tournamentLockedQuantity: integer("tournament_locked_quantity").notNull(),
    averageCostAmount: integer("average_cost_amount").notNull(),
    marketValueAmount: integer("market_value_amount"),
    marketValueCapturedAt: text("market_value_captured_at"),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [
    uniqueIndex("inventory_holdings_user_sku_unique").on(table.userId, table.skuId),
    index("inventory_holdings_user_updated_index").on(table.userId, table.updatedAt)
  ]
);

export const inventoryHolds = sqliteTable(
  "inventory_holds",
  {
    id: text("id").primaryKey(),
    holdingId: text("holding_id")
      .notNull()
      .references(() => inventoryHoldings.id),
    reason: text("reason").notNull(),
    quantity: integer("quantity").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    status: text("status").notNull(),
    createdAt: text("created_at").notNull(),
    releasedAt: text("released_at")
  },
  (table) => [
    index("inventory_holds_holding_status_index").on(table.holdingId, table.status),
    uniqueIndex("inventory_holds_entity_unique").on(
      table.holdingId,
      table.reason,
      table.entityType,
      table.entityId
    )
  ]
);

export const inventoryEntries = sqliteTable(
  "inventory_entries",
  {
    id: text("id").primaryKey(),
    holdingId: text("holding_id")
      .notNull()
      .references(() => inventoryHoldings.id),
    reason: text("reason").notNull(),
    quantityDelta: integer("quantity_delta").notNull(),
    availableQuantityDelta: integer("available_quantity_delta").notNull(),
    orderLockedQuantityDelta: integer("order_locked_quantity_delta").notNull(),
    tournamentLockedQuantityDelta: integer("tournament_locked_quantity_delta").notNull(),
    quantityAfter: integer("quantity_after").notNull(),
    averageCostAfter: integer("average_cost_after").notNull(),
    correlationId: text("correlation_id").notNull(),
    occurredAt: text("occurred_at").notNull()
  },
  (table) => [
    index("inventory_entries_holding_occurred_index").on(table.holdingId, table.occurredAt)
  ]
);

/** I11B：补充包商品及其不可变规则快照；保底状态明确不在 MVP 数据模型中。 */
export const boosterPacks = sqliteTable(
  "booster_packs",
  {
    id: text("id").primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    priceAmount: integer("price_amount").notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    disabledReason: text("disabled_reason"),
    activeRuleVersion: text("active_rule_version").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull()
  },
  (table) => [uniqueIndex("booster_packs_code_unique").on(table.code)]
);

export const boosterPackRules = sqliteTable(
  "booster_pack_rules",
  {
    id: text("id").primaryKey(),
    packId: text("pack_id")
      .notNull()
      .references(() => boosterPacks.id),
    version: text("version").notNull(),
    definitionJson: text("definition_json").notNull(),
    createdAt: text("created_at").notNull(),
    retiredAt: text("retired_at")
  },
  (table) => [
    uniqueIndex("booster_pack_rules_pack_version_unique").on(table.packId, table.version),
    index("booster_pack_rules_pack_index").on(table.packId, table.createdAt)
  ]
);

export const packRuleReplays = sqliteTable(
  "pack_rule_replays",
  {
    id: text("id").primaryKey(),
    packId: text("pack_id")
      .notNull()
      .references(() => boosterPacks.id),
    packRuleId: text("pack_rule_id")
      .notNull()
      .references(() => boosterPackRules.id),
    randomSeed: text("random_seed").notNull(),
    randomSeedHash: text("random_seed_hash").notNull(),
    resultSummaryJson: text("result_summary_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [index("pack_rule_replays_pack_created_index").on(table.packId, table.createdAt)]
);

/** I12B：玩家已结算的开包结果；随机重放、账本、库存与事实事件由同一短事务共同提交。 */
export const packOpenings = sqliteTable(
  "pack_openings",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    packId: text("pack_id")
      .notNull()
      .references(() => boosterPacks.id),
    packRuleReplayId: text("pack_rule_replay_id")
      .notNull()
      .references(() => packRuleReplays.id),
    packRuleVersion: text("pack_rule_version").notNull(),
    spentAmount: integer("spent_amount").notNull(),
    resultSummaryJson: text("result_summary_json").notNull(),
    createdAt: text("created_at").notNull()
  },
  (table) => [
    uniqueIndex("pack_openings_replay_unique").on(table.packRuleReplayId),
    index("pack_openings_user_created_index").on(table.userId, table.createdAt),
    index("pack_openings_pack_created_index").on(table.packId, table.createdAt)
  ]
);
