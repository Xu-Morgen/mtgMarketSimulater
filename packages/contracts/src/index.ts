/**
 * 跨应用共享的 API、事件与幂等契约。
 *
 * 金额一律以最小货币单位的整数表达；所有时间均为 UTC ISO 8601 字符串。
 * 这里的事件只描述已经提交的业务事实，绝不能被当作结算命令消费。
 */

export const CONTRACTS_VERSION = "2026-07-31" as const;

export type CurrencyCode = "EUR" | "GAME_CREDIT";
export type PriceSource = "mtgjson-cardmarket" | "manual-test";
export type Role = "player" | "admin";
export type CardFinish = "nonfoil" | "foil" | "etched";
/** 目录资料的来源；人工例外不得伪装成外部同步资料或价格。 */
export type CatalogSource = "scryfall" | "manual-test";
export type InventoryLockReason = "order" | "tournament";
/** I24R/I33B 的候选报名评分来源；结算只能读取报名时已持久化的快照。 */
export type DeckPowerSource = "leyline" | "local" | "ml";
/** 快照可用但使用了已批准的 Provider 降级策略时明确标记为 degraded。 */
export type DeckPowerAvailability = "available" | "degraded";
export type DeckPowerDegradationReason =
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_schema_invalid"
  | "provider_response_invalid";

/**
 * 报名时的不可变卡组强度快照候选契约。
 * `sourceVersion` 对 local 为规则/参数版本，对 leyline 为本地适配器版本，对 ml 为不可变
 * 模型工件版本；Provider 未声明算法版本时保留字面值 `undeclared`，而不是由浏览器或服务端猜测。
 */
export interface DeckPowerSnapshotDto {
  source: DeckPowerSource;
  sourceVersion: string;
  providerAlgorithmVersion: string | null;
  score: number;
  inputSummarySha256: string;
  computedAt: string;
  availability: DeckPowerAvailability;
  degradationReason: DeckPowerDegradationReason | null;
  responseSha256: string | null;
}
export type DeckZone = "commander" | "main" | "companion" | "virtual_basic";
export type VirtualBasicLandDto = "plains" | "island" | "swamp" | "mountain" | "forest";
export interface DeckCardEntryDto {
  zone: DeckZone;
  skuId: string | null;
  /** virtual_basic 使用固定枚举，永远不引用库存 SKU。 */
  virtualBasic: VirtualBasicLandDto | null;
  quantity: number;
  name: string;
  cardIdentity: string;
}
export interface DeckLegalityDto {
  valid: boolean;
  totalCards: number;
  colorIdentity: Array<"W" | "U" | "B" | "R" | "G">;
  issues: string[];
  ruleVersion: string;
  banlistVersion: string;
  checkedAt: string;
}
export interface DeckDto {
  id: string;
  name: string;
  format: "commander-100/v1";
  ruleVersion: string;
  banlistVersion: string;
  cards: DeckCardEntryDto[];
  legality: DeckLegalityDto;
  strengthSnapshot: DeckPowerSnapshotDto | null;
  createdAt: string;
  updatedAt: string;
}
export type OrderSide = "buy" | "sell";
export type OrderStatus =
  | "open"
  | "partially_filled"
  | "matched_pending_fulfillment"
  | "fulfilled"
  | "cancelled"
  | "expired";
export type OrderRiskAction = "create" | "cancel" | "match";
export type OrderRiskOutcome = "allowed" | "blocked" | "flagged";
export interface OrderRiskDecisionDto {
  id: string;
  orderId: string | null;
  skuId: string;
  action: OrderRiskAction;
  outcome: OrderRiskOutcome;
  score: number;
  reasons: string[];
  ruleVersion: string;
  createdAt: string;
}
export type JobStatus = "pending" | "running" | "succeeded" | "failed" | "dead";

export type ApiErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTHENTICATION_INVALID"
  | "AUTHORIZATION_DENIED"
  | "VALIDATION_FAILED"
  | "RESOURCE_NOT_FOUND"
  | "RESOURCE_CONFLICT"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_INVENTORY"
  | "INVENTORY_LOCKED"
  | "PRICE_UNAVAILABLE"
  | "SCORING_UNAVAILABLE"
  | "VERSION_STALE"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "RATE_LIMITED"
  | "RULE_VIOLATION"
  | "INTERNAL_ERROR";

export interface Money {
  /** 最小货币单位；禁止使用浮点数。 */
  amount: number;
  currency: CurrencyCode;
}

export interface PageRequest {
  cursor?: string;
  limit?: number;
}

export interface PageInfo {
  nextCursor: string | null;
  hasMore: boolean;
  /** 可选总数；目录等支持随机页跳转的查询会提供精确值。 */
  total?: number;
}

export interface Page<T> {
  items: T[];
  page: PageInfo;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta: { requestId: string };
}

export interface ApiFailure {
  ok: false;
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
  meta: { requestId: string };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export interface IdempotencyRequest {
  /** HTTP `Idempotency-Key` header value. */
  idempotencyKey: string;
  /** API 对规范化请求体计算的 SHA-256 十六进制摘要。 */
  requestFingerprint: string;
}

export interface IdempotencyReplay<T> {
  state: "completed";
  response: ApiSuccess<T> | ApiFailure;
}

export interface IdempotencyConflict {
  state: "conflict";
  error: ApiFailure;
}

export type IdempotencyResolution<T> = IdempotencyReplay<T> | IdempotencyConflict;

export interface UserDto {
  id: string;
  displayName: string;
  role: Role;
  createdAt: string;
}

export interface CardSku {
  id: string;
  scryfallId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  finish: CardFinish;
  imagePath: string | null;
  tradable: boolean;
}

/** 以印刷版本加工艺为唯一资产粒度的只读目录条目。 */
export interface CatalogSkuDto extends CardSku {
  printingId: string;
  setName: string;
  rarity: string;
  /** Scryfall 费用符号的本地快照；null 表示该印刷未提供。 */
  manaCost: string | null;
  /** 卡面颜色与颜色标识均由服务器目录快照返回，浏览器只用于筛选展示。 */
  colors: Array<"W" | "U" | "B" | "R" | "G">;
  colorIdentity: Array<"W" | "U" | "B" | "R" | "G">;
  typeLine: string;
  power: string | null;
  toughness: string | null;
  legalities: Record<string, string>;
  source: CatalogSource;
  sourceReference: string | null;
  isManualException: boolean;
  image: {
    path: string | null;
    sourceUrl: string | null;
    status: "missing" | "cached" | "failed";
    cachedAt: string | null;
  };
}

export interface CatalogSkuDetailDto extends CatalogSkuDto {
  oracleText: string | null;
  artist: string | null;
  releasedAt: string | null;
}

/** 管理端目录同步的脱敏运行记录；不向浏览器暴露外部下载地址。 */
export interface CatalogSyncRunDto {
  id: string;
  sourceVersion: string;
  checksumSha256: string;
  enabledSetCodes: string[];
  status: "running" | "succeeded" | "failed";
  importedPrintings: number;
  importedSkus: number;
  cachedImages: number;
  diff: { printings?: number; skus?: number; added?: number; removed?: number };
  failureReason: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface CatalogSyncStatusDto {
  latestSuccessful: CatalogSyncRunDto | null;
  current: CatalogSyncRunDto | null;
  /** 最近投递的同步任务，供刷新后继续追踪状态。 */
  currentJob: JobDto | null;
  /** 最近投递的卡图缓存任务；目录同步与卡图下载互不重建对方的数据。 */
  currentImageCacheJob: JobDto | null;
}

/** 补充包概率仅由服务端按已发布规则版本计算；basis points 总和固定为 10_000。 */
export interface PackRarityProbabilityDto {
  rarity: string;
  probabilityBasisPoints: number;
}

export interface PackSlotDto {
  id: string;
  draws: number;
  rarityProbabilities: PackRarityProbabilityDto[];
}

/** 玩家可读的补充包配置；不含候选 SKU 明细、随机种子或任何保底状态。 */
export interface PackDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  price: Money;
  enabled: boolean;
  disabledReason: string | null;
  ruleVersion: string;
  slots: PackSlotDto[];
  /** I33B：关联的限时销售窗口；无 offer 的普通包为 null。 */
  offer: PackOfferDto | null;
  updatedAt: string;
}

/** 购买前由服务端生成的补充包预览；客户端须回传 ruleVersion 以避免按过期配置结算。 */
export interface PackPurchasePreviewDto {
  pack: PackDto;
  ruleVersion: string;
  cost: Money;
  canPurchase: boolean;
  unavailableReason: "insufficient_balance" | "archive_required" | null;
}

/** I17B 前没有可用的外部参考价或游戏内报价，开包结果必须明确标注该状态。 */
export type PackOpeningPriceStatus = "unavailable_until_i17" | "available";

export interface PackOpeningCardDto {
  skuId: string;
  quantity: number;
  /** 此 SKU 在本次开包中分摊到的总成本，所有结果项之和等于 spent。 */
  cost: Money;
  referencePrice: Money | null;
  gamePrice: Money | null;
  priceStatus: PackOpeningPriceStatus;
  /** I33B：本次结算前该 SKU 是否已持有（同一印刷任意工艺任一持有即视为已收集）；浏览器不得自行比对库存。 */
  isNewToCollection: boolean;
  /** I33B：开包后该 SKU 所在系列的完成度快照（按服务端目录与库存投影计算）。 */
  collectionProgressAfter: {
    setCode: string;
    collectedSkuCount: number;
    totalSkuCount: number;
    completionBasisPoints: number;
  };
}

export interface PackOpeningProfitLossDto {
  spent: Money;
  referenceValue: Money | null;
  gameValue: Money | null;
  referenceProfitLoss: Money | null;
  gameProfitLoss: Money | null;
  priceStatus: PackOpeningPriceStatus;
}

/** 玩家可读取的已结算开包结果；随机种子及候选池永不出现在此 DTO。 */
export interface PackOpeningDto {
  id: string;
  packId: string;
  packRuleVersion: string;
  spent: Money;
  received: PackOpeningCardDto[];
  profitLoss: PackOpeningProfitLossDto;
  /** I33B：本包总成本（= spent），与 received 各卡成本之和恒等。 */
  totalCost: Money;
  /** I33B：本包总价值，按结算时已持久化报价快照计算；任一卡无有效报价时为 null，不掩盖缺价状态。 */
  totalGameValue: Money | null;
  openedAt: string;
}

/** I33B：特殊补充包限时销售窗口；有 offer 的包只在该窗口内以折扣价可购买，窗口外与下架同语义拒绝。 */
export interface PackOfferDto {
  id: string;
  packId: string;
  name: string;
  description: string | null;
  /** 10_000 = 无折扣；窗口内实际售价 = price × discountBps ÷ 10_000，整数向下取整。 */
  discountBps: number;
  startsAt: string;
  endsAt: string;
  status: "scheduled" | "active" | "ended";
  version: number;
  updatedAt: string;
}

/** I33B：批量开包汇总；每包仍保留独立 opening/replay/fact，仅汇总服务端计算值。 */
export interface BulkPackOpeningSummaryDto {
  packId: string;
  packRuleVersion: string;
  count: number;
  rarityCounts: Array<{ rarity: string; quantity: number }>;
  totalCost: Money;
  totalGameValue: Money | null;
  /** 本次批量中新加入收藏（结算前未持有）的不同 SKU 数。 */
  newSkuCount: number;
}

export interface BulkPackOpeningDto {
  summary: BulkPackOpeningSummaryDto;
  /** 逐包结果，供前端下钻；顺序与结算顺序一致。 */
  openings: PackOpeningDto[];
}

/** I33B：重复卡批量向 NPC 卖出的逐 SKU 结果；全部结算在同一短事务内，任何写入失败整批回滚。 */
export interface DuplicatesSellItemDto {
  skuId: string;
  quantity: number;
  unitPrice: Money;
  unitFee: Money;
  total: Money;
  fee: Money;
}

export type DuplicatesSellSkipReason =
  | "no_duplicate"
  | "locked"
  | "quote_unavailable"
  | "quote_stale"
  | "trade_limit_reached";

export interface DuplicatesSellResultDto {
  soldItems: DuplicatesSellItemDto[];
  skippedItems: Array<{ skuId: string; reason: DuplicatesSellSkipReason }>;
  cardCount: number;
  income: Money;
  fee: Money;
}

/** I34B（D4）：按筛选结果批量向 NPC 卖出的单个已成交 SKU；价格均来自不可变报价快照。 */
export interface BatchNpcSellItemDto {
  skuId: string;
  quantity: number;
  unitPrice: Money;
  unitFee: Money;
  total: Money;
  fee: Money;
}

/** I34B（D4）：批量卖出跳过项的原因；全部由服务端在单事务内判定，浏览器不推算。 */
export type BatchNpcSellSkipReason =
  | "not_held"
  | "no_available_quantity"
  | "quote_unavailable"
  | "quote_stale"
  | "trade_limit_reached";

/** I34B（D4）：批量卖出汇总；与 C8 重复卡清仓不同，不保留任何一张可用库存。 */
export interface BatchNpcSellResultDto {
  soldItems: BatchNpcSellItemDto[];
  skippedItems: Array<{ skuId: string; reason: BatchNpcSellSkipReason }>;
  cardCount: number;
  income: Money;
  fee: Money;
}

/** I33B：收藏图鉴只读聚合；未收集卡位用于灰影占位，浏览器不得统计或估值。 */
export interface CollectionUncollectedCardDto {
  name: string;
  setCode: string;
  collectorNumber: string;
  rarity: string;
}

export interface CollectionSetGroupDto {
  setCode: string;
  setName: string;
  /** 该系列玩家已持有（quantity > 0）的不同 SKU 数；按印刷工艺粒度。 */
  collectedSkuCount: number;
  totalSkuCount: number;
  /** 完成度 = collectedSkuCount × 10_000 ÷ totalSkuCount，服务端整数计算。 */
  completionBasisPoints: number;
  /** 该系列未收集卡位（按印刷去重，任一工艺已持有即视为已收集）；用于灰影占位。 */
  uncollectedCards: CollectionUncollectedCardDto[];
}

export interface CollectionAlbumDto {
  /** 按系列分组的图鉴；分页按系列排序。 */
  sets: Page<CollectionSetGroupDto>;
}

export interface InventoryDto {
  skuId: string;
  quantity: number;
  availableQuantity: number;
  orderLockedQuantity: number;
  tournamentLockedQuantity: number;
  averageCost: Money;
  /** 当前服务端报价投影的单张游戏内价；无可用报价时为 null。 */
  marketUnitPrice: Money | null;
  /** 当前服务端报价投影按全部持有量计算的市值；浏览器不得自行相乘。 */
  marketValue: Money | null;
  /** 当前服务端市值减去全部持有成本的未实现盈亏；可为负数。 */
  unrealizedProfitLoss: Money | null;
  updatedAt: string;
}

/** 玩家按 SKU 持有的库存真相；卡牌资料只用于展示，数量与成本均来自服务端库存账。 */
export interface InventoryHoldingDto extends InventoryDto {
  sku: Pick<
    CatalogSkuDto,
    "id" | "name" | "setCode" | "setName" | "collectorNumber" | "finish" | "imagePath" | "tradable" | "manaCost" | "colors" | "colorIdentity" | "typeLine" | "power" | "toughness"
  > & { oracleText: string | null };
  /** 没有有效价格快照时为 null，原因由服务端明确给出。 */
  marketValueUnavailableReason: "no_snapshot" | "stale_snapshot" | null;
}

export interface InventoryEntryDto {
  id: string;
  userId: string;
  skuId: string;
  reason: string;
  quantityDelta: number;
  availableQuantityDelta: number;
  orderLockedQuantityDelta: number;
  tournamentLockedQuantityDelta: number;
  quantityAfter: number;
  averageCostAfter: Money;
  correlationId: string;
  occurredAt: string;
}

export interface InventoryReconciliationDto {
  skuId: string;
  quantity: number;
  availableQuantity: number;
  orderLockedQuantity: number;
  tournamentLockedQuantity: number;
  reconciled: boolean;
  entries: Page<InventoryEntryDto>;
}

export interface AccountBalanceDto {
  /** total = available + frozen，三个值均以整数最小单位表达。 */
  total: Money;
  available: Money;
  frozen: Money;
  updatedAt: string;
}

/** I23B：每日工作资金资格和领取结果均为服务端时区下的自然日快照。 */
export interface DailyWorkFundingDto {
  id: string;
  naturalDate: string;
  timezone: string;
  amount: Money;
  ruleVersion: string;
  claimedAt: string;
}

export interface DailyWorkFundingStatusDto {
  naturalDate: string;
  timezone: string;
  status: "available" | "claimed" | "not_open" | "archive_required";
  amount: Money | null;
  ruleVersion: string | null;
  openedAt: string | null;
  nextEligibleAt: string;
  claim: DailyWorkFundingDto | null;
}

export interface GameArchiveSummaryDto {
  id: string;
  userId: string;
  initialFundingRuleVersion: string;
  createdAt: string;
  balance: AccountBalanceDto;
  /** I07 的占位字段；后续库存与价格快照完成后才由服务端填充实际净资产。 */
  netWorth: Money | null;
}

/** I27F 玩家首页只读投影；所有金额、收藏统计与待办资格均由服务端聚合。 */
export interface PlayerDashboardDto {
  balance: AccountBalanceDto;
  /** 账户总额加可完整估值的库存市值；存在未报价持仓时为 null，避免误导性部分净资产。 */
  netWorth: Money | null;
  collection: {
    distinctSkuCount: number;
    totalCardCount: number;
    marketValue: Money | null;
    unpricedSkuCount: number;
  };
  dailyWorkFunding: DailyWorkFundingStatusDto;
  todayTournaments: {
    availableCount: number;
    registeredCount: number;
    settlingCount: number;
    settledCount: number;
  };
  marketIndex: MarketIndexDto;
  todos: Array<{
    id: "claim_daily_work_funding" | "acquire_cards" | "build_deck" | "register_tournament" | "claim_task_rewards" | "continue_onboarding";
    label: string;
    href: string;
  }>;
  capturedAt: string;
}

export interface QuoteDto {
  /** 不可变报价快照标识；交易确认必须回传它，客户端不得自行拼接金额。 */
  quoteId: string;
  skuId: string;
  quoteVersion: string;
  referencePrice: Money | null;
  marketPrice: Money;
  npcBuyPrice: Money;
  npcSellPrice: Money;
  validUntil: string;
  source: PriceSource | null;
  capturedAt: string;
  /** 服务端规则在本次报价中实际消费的已受界因素；仅供解释，不可用于浏览器重算。 */
  reasons: Array<{
    kind: "supply-demand" | "series-cycle" | "relation" | "event" | "liquidity" | "bias";
    factorBasisPoints: number;
    reason: string;
  }>;
}

/** NPC 向玩家出售时的服务端预览；费用已包含在 unitPrice/total 中，仅作拆分展示。 */
export interface NpcBuyPreviewDto {
  skuId: string;
  quantity: number;
  quoteId: string;
  quoteVersion: string;
  unitPrice: Money;
  unitFee: Money;
  total: Money;
  fee: Money;
  validUntil: string;
  limit: {
    maxQuantityPerTrade: number;
    maxQuantityPerUserSkuDay: number;
    remainingQuantityToday: number;
  };
  canPurchase: boolean;
  unavailableReason: "archive_required" | "insufficient_balance" | "trade_limit_reached" | null;
}

/** 玩家向 NPC 出售时的服务端预览；`quantity=all` 在 HTTP 边界解析为当前可用库存。 */
export interface NpcSellPreviewDto {
  skuId: string;
  quantity: number;
  availableQuantity: number;
  quoteId: string;
  quoteVersion: string;
  /** NPC 收购单价，已扣除规则定义的价差与费用。 */
  unitPrice: Money;
  unitFee: Money;
  total: Money;
  fee: Money;
  validUntil: string;
  limit: {
    maxQuantityPerTrade: number;
    maxQuantityPerUserSkuDay: number;
    remainingQuantityToday: number;
  };
  canSell: boolean;
  unavailableReason: "archive_required" | "insufficient_inventory" | "trade_limit_reached" | null;
}

/** 已结算 NPC 交易；价格字段来自所引用的不可变市场报价快照。 */
export interface NpcTradeDto {
  id: string;
  userId: string;
  skuId: string;
  side: "buy" | "sell";
  quantity: number;
  quoteId: string;
  quoteVersion: string;
  unitPrice: Money;
  unitFee: Money;
  total: Money;
  fee: Money;
  settledAt: string;
}

/** 新手首笔交易的服务端保底机会。价格仍引用不可变市场报价，仅放宽本次教程的普通 SKU 启停门禁。 */
export type OnboardingTradeOpportunityDto =
  | {
      status: "available";
      ruleVersion: "onboarding-liquidity/v1";
      side: "sell";
      holding: InventoryHoldingDto;
      preview: NpcSellPreviewDto;
    }
  | {
      status: "available";
      ruleVersion: "onboarding-liquidity/v1";
      side: "buy";
      item: MarketQuoteListItemDto;
      preview: NpcBuyPreviewDto;
    }
  | {
      status: "completed";
      ruleVersion: "onboarding-liquidity/v1";
    }
  | {
      status: "unavailable";
      ruleVersion: "onboarding-liquidity/v1";
      reason: "prerequisite_incomplete" | "archive_required" | "quote_unavailable" | "trade_limit_reached";
    };

/** I14F 市场列表的只读投影；价格、可交易资格和禁用原因均由 API 判定。 */
export interface MarketQuoteListItemDto {
  sku: Pick<CatalogSkuDto, "id" | "name" | "setCode" | "setName" | "collectorNumber" | "finish" | "rarity" | "imagePath" | "typeLine">;
  quote: QuoteDto | null;
  tradable: boolean;
  tradeDisabledReason: "no_valid_reference_price" | "quote_unavailable" | null;
}

/** 不可变外部参考价快照；游戏内报价使用 QuoteDto 表达。 */
export interface PriceSnapshot {
  skuId: string;
  source: PriceSource;
  sourcePrice: Money;
  capturedAt: string;
  sourceVersion: string;
}

/** I17B 价格历史时间范围；服务端按自然日采样，不返回原始分钟级流水。 */
export type PriceHistoryRange = "7d" | "30d" | "all";

/** I17B 单卡按自然日采样的历史点；reference/game 任一缺失时为 null，不掩盖空态。 */
export interface PriceHistoryPointDto {
  /** UTC 自然日 YYYY-MM-DD。 */
  date: string;
  referencePrice: Money | null;
  marketPrice: Money | null;
}

/** I17B 单卡价格历史；points 按日期升序，空数组表示无历史而非查询失败。 */
export interface PriceHistoryDto {
  skuId: string;
  range: PriceHistoryRange;
  points: PriceHistoryPointDto[];
  referenceSource: "mtgjson-cardmarket" | null;
  generatedAt: string;
}

/** I17B 全服市场指数按自然日采样的历史点。 */
export interface MarketIndexHistoryPointDto {
  /** UTC 自然日 YYYY-MM-DD。 */
  date: string;
  referenceIndex: number | null;
  gameIndex: number | null;
}

/** I17B 全服市场指数历史；空数组表示无历史。 */
export interface MarketIndexHistoryDto {
  range: PriceHistoryRange;
  points: MarketIndexHistoryPointDto[];
  generatedAt: string;
}

/** I27F 首页市场指数；计算和采样均由服务端市场投影完成。 */
export interface MarketIndexDto {
  referenceIndex: number | null;
  gameIndex: number | null;
  quotedSkus: number;
  capturedAt: string | null;
}

/** I34B：行情屏涨跌榜/活跃榜的单条条目；涨跌幅与方向均由服务端按报价快照与已结算事实聚合。 */
export interface MarketHeatEntryDto {
  sku: Pick<CatalogSkuDto, "id" | "name" | "setCode" | "setName" | "collectorNumber" | "finish" | "rarity">;
  /** 相对基准日期的游戏内中间价变化（bp，10_000 为无变化）；涨跌榜用整数，不可在浏览器重算。 */
  changeBasisPoints: number;
  /** 变化方向：up/down/flat，由服务端判定。 */
  direction: "up" | "down" | "flat";
  /** 当前游戏内中间价（整数最小货币单位）。 */
  currentPrice: Money;
  /** 基准日期的游戏内中间价；无历史采样时为 null。 */
  basePrice: Money | null;
}

/** I34B：市场热度只读聚合；含日内/7 日涨跌榜与当日最活跃交易榜（数量与金额）。 */
export interface MarketHeatDto {
  intradayGainers: MarketHeatEntryDto[];
  intradayLosers: MarketHeatEntryDto[];
  sevenDayGainers: MarketHeatEntryDto[];
  sevenDayLosers: MarketHeatEntryDto[];
  /** 当日最活跃：按已结算 NPC/P2P 成交量（张数）排序的服务端聚合。 */
  mostActive: Array<{
    sku: MarketHeatEntryDto["sku"];
    quantity: number;
    turnover: Money;
  }>;
  capturedAt: string;
}

/** I34B：系列周期/市场活动的只读公告；只暴露标题、影响范围与生效区间，绝不暴露内部系数与配置。 */
export interface MarketAnnouncementDto {
  type: "series_cycle" | "market_event";
  title: string;
  /** 影响范围：global | set | sku。 */
  scope: "global" | "set" | "sku";
  setCode: string | null;
  setName: string | null;
  skuName: string | null;
  startsAt: string;
  endsAt: string;
  reason: string;
}

export interface MarketAnnouncementsDto {
  items: MarketAnnouncementDto[];
  /** 只包含当前 UTC 时刻生效中的公告；到期即不再返回。 */
  capturedAt: string;
}

/** I34B（E12）：Watchlist 目标价提醒条目；目标价与方向只由服务端保存与判定。 */
export interface WatchlistItemDto {
  id: string;
  skuId: string;
  targetType: "game_price" | "reference_price";
  direction: "at_or_below" | "at_or_above";
  targetAmount: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** I34B（E12）：已触达的站内提醒；命中判定与触发价均来自服务端，浏览器不得重判。 */
export interface WatchlistAlertDto {
  id: string;
  watchlistItemId: string;
  skuId: string;
  targetType: "game_price" | "reference_price";
  direction: "at_or_below" | "at_or_above";
  targetAmount: number;
  /** 触发时刻的最新报价（整数最小货币单位），引用不可变报价快照。 */
  triggeredPrice: number;
  triggeredAt: string;
  read: boolean;
}

export interface WatchlistAlertsDto {
  items: WatchlistAlertDto[];
  unreadCount: number;
}

export interface WatchlistLimitsDto {
  maxItemsPerUser: number;
}

/** I13B 管理端价格同步状态；下载地址和 Provider 原始内容永不进入 DTO。 */
export interface PriceSyncRunDto {
  id: string;
  sourceVersion: string;
  pricesChecksumSha256: string;
  mappingChecksumSha256: string;
  status: "running" | "succeeded" | "failed";
  /** 成功运行是否经过 Provider SHA-256 校验；bypassed 只能由管理员明确覆写产生。 */
  checksumVerification: "verified" | "bypassed" | "not_verified";
  /** I17B：daily 为每日 AllPricesToday 同步，backfill 为一次性 AllPrices 历史回填。 */
  runKind: "daily" | "backfill";
  mappedSkus: number;
  pricedSkus: number;
  unpricedSkus: number;
  mappingFailedSkus: number;
  failureCode: "CHECKSUM_MISMATCH" | null;
  failureReason: string | null;
  startedAt: string;
  completedAt: string | null;
}

export interface PriceSyncStatusDto {
  latestSuccessful: PriceSyncRunDto | null;
  current: PriceSyncRunDto | null;
  currentJob: JobDto | null;
  /** 仅当最近失败确定为 Provider checksum 不匹配时，管理员才可请求一次覆写任务。 */
  checksumBypassAvailable: boolean;
}

/** 玩家可读的价格来源状态；不包含同步版本、校验和、任务或失败详情。 */
export interface PublicPriceStatusDto {
  source: "mtgjson-cardmarket" | null;
  updatedAt: string | null;
  freshness: "fresh" | "stale" | "unavailable";
  /** I17B：服务端固定的数据源与资产性质说明；浏览器不得自行拼接或改写。 */
  disclaimer: string;
}

/** I17B 一次性 AllPrices 历史回填运行结果；只追加缺失日期，不改写日常同步指针。 */
export interface PriceSyncBackfillResultDto {
  latestRun: PriceSyncRunDto | null;
  /** 只追加的历史日期范围（UTC YYYY-MM-DD）；空表示尚未成功回填。 */
  backfilledFromDate: string | null;
  backfilledToDate: string | null;
  insertedEntries: number;
  skippedExistingEntries: number;
  currentJob: JobDto | null;
}

export interface FeeDto {
  kind: "npc_spread" | "order_fee" | "fulfillment_deposit";
  amount: Money;
}

export interface LedgerEntryDto {
  id: string;
  userId: string;
  direction: "credit" | "debit";
  amount: Money;
  balanceAfter: Money;
  reason: string;
  occurredAt: string;
  correlationId: string;
}

export interface JobDto {
  id: string;
  type: string;
  status: JobStatus;
  attempt: number;
  maxAttempts: number;
  uniqueKey: string;
  scheduledAt: string;
  lockedUntil: string | null;
  lastError: string | null;
  updatedAt: string;
}

export interface BilateralOrderDto {
  id: string;
  userId: string;
  skuId: string;
  side: OrderSide;
  status: OrderStatus;
  originalQuantity: number;
  remainingQuantity: number;
  limitPrice: Money;
  fees: FeeDto[];
  reservedFunds: Money | null;
  reservedInventoryQuantity: number;
  fulfillmentDeposit: Money | null;
  expiresAt: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/** P2P 委托限价有效范围；锚点为当前 market_quotes.market_price，浏览器不得自行重算。 */
export interface BilateralOrderLimitBandDto {
  /** 锚点市场中间价，整数最小货币单位。 */
  marketPrice: Money;
  min: Money;
  max: Money;
  /** 服务端配置的限价带宽度（bp）；10_000 = 1:1。 */
  limitPriceBandBasisPoints: number;
}

/** I18B 下双边委托的服务端预览；客户端不可编造费用、保证金或限价带。 */
export interface BilateralOrderPreviewDto {
  skuId: string;
  side: OrderSide;
  quantity: number;
  /** 仅卖单填充：当前可用于挂卖单的可用库存（不含订单/比赛锁定）。 */
  availableQuantity?: number;
  quoteId: string;
  quoteVersion: string;
  /** 服务端规则在该预览中实际采用的费用拆分；买单 order_fee 已计入 reservedFunds，卖单只预占 fulfillment_deposit。 */
  fees: FeeDto[];
  /** 买单：数量*限价+order_fee；卖单：fulfillment_deposit。 */
  reservedFunds: Money;
  /** 买单：预计支出；卖单：按限价计算的预计到手（未扣 order_fee，后者在 I19B/I20B 履约时结算）。 */
  estimatedAmount: Money;
  limitBand: BilateralOrderLimitBandDto;
  /** 服务端计算的预览版本；创建必须回传未过期的该值，且与 quoteVersion 一致。 */
  previewVersion: string;
  validUntil: string;
  limit: {
    maxQuantityPerOrder: number;
    maxQuantityPerUserSkuDay: number;
    remainingQuantityToday: number;
    ttlSeconds: number;
  };
  canPlace: boolean;
  unavailableReason:
    | "archive_required"
    | "insufficient_balance"
    | "insufficient_inventory"
    | "trade_limit_reached"
    | null;
}

/** I18B 只读订单簿条目；价格-时间优先顺序由服务端返回，不含用户身份。 */
export interface BilateralOrderBookLevelDto {
  limitPrice: Money;
  remainingQuantity: number;
  /** I34B：从最优档开始逐档累计的委托数量；累计只由服务端计算，浏览器不得自行累加。 */
  cumulativeQuantity: number;
  orderCount: number;
}

export interface BilateralOrderBookDto {
  skuId: string;
  bids: BilateralOrderBookLevelDto[];
  asks: BilateralOrderBookLevelDto[];
  /**
   * I34B：盘口中间价 =（最优买 + 最优卖）÷ 2（整数 half-up）；买/卖任一档缺失时为 null。
   * 价差 = 最优卖 − 最优买；任一档缺失时为 null。均由服务端聚合。
   */
  midPrice: Money | null;
  spread: Money | null;
  /** 订单簿数据截至时间；连接失败时浏览器应提示可能过期。 */
  capturedAt: string;
}

/**
 * I19B 成交记录状态：撮合只产出 `matched_pending_fulfillment`；I20B 履约结算推进为 `fulfilled`，
 * 取消履约或到期回收推进为 `cancelled`。
 */
export type BilateralTradeStatus = "matched_pending_fulfillment" | "fulfilled" | "cancelled";

/**
 * I20B 模拟履约类型。本期只支持 `simulated`：成交后的确认/取消是经济结算动作，不引入实体
 * 物流状态；客户端只能展示服务端返回的类型，不可自行推导或扩展。
 */
export type BilateralFulfillmentType = "simulated";

/** I19B 单笔 P2P 成交；撮合只把预占转为待履约持有，不转移最终所有权、不写 p2p.trade.settled。 */
export interface BilateralTradeDto {
  id: string;
  skuId: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  quantity: number;
  /** 取 maker（先入订单簿一方）限价的成交价，整数最小货币单位。 */
  executionPrice: Money;
  /** 买单已成交部分 order_fee；撮合时确认并转入买方待履约资金 hold。 */
  buyerFee: Money;
  /** 卖单已成交部分 order_fee；撮合时锁定，I20B 履约时从卖方收入结算。 */
  sellerFee: Money;
  /** 撮合规则版本，可追溯价格—时间优先与成交价取 maker 的语义。 */
  ruleVersion: string;
  /**
   * I20B 待履约期限（UTC ISO 8601）：撮合时刻起按 `bilateral_order_limits.ttl_seconds` 派生，
   * 到期由 order.expire 任务把成交推进为取消履约；已 fulfilled/cancelled 的成交不再迁移。
   */
  fulfillmentDeadline: string;
  status: BilateralTradeStatus;
  createdAt: string;
  updatedAt: string;
}

/** I19B 一次撮合返回的成交列表；不包含用户身份敏感字段以外的内容。 */
export interface MatchResultDto {
  skuId: string;
  trades: BilateralTradeDto[];
  /** 本次撮合数据截至时间。 */
  capturedAt: string;
}

/**
 * I19F 玩家视角的单笔 P2P 成交。从 `bilateral_trades` 投影，对手身份（userId、orderId、holdId）
 * 一律脱敏不返回；附当前玩家在本笔成交中的角色与已转入待履约的资产。浏览器不得推导或缓存为真相。
 */
export interface PlayerBilateralTradeDto {
  id: string;
  skuId: string;
  /** 当前玩家在本笔成交中的角色。 */
  role: "buyer" | "seller";
  /** 当前玩家自己的委托 ID；对手委托 ID 不暴露。 */
  myOrderId: string;
  quantity: number;
  /** 取 maker（先入订单簿一方）限价的成交价，整数最小货币单位。 */
  executionPrice: Money;
  /** 当前玩家本笔已成交 order_fee（买方/卖方各自的单位费用×数量）。 */
  fee: Money;
  /**
   * 当前玩家本笔待履约资金：买方=数量×成交价+order_fee，卖方=已成交保证金。
   * 撮合只把预占转为待履约持有，最终所有权转移与结算在 I20B 履约时发生。
   */
  pendingFunds: Money | null;
  /** 仅卖方填充：本笔已离开持有的待履约库存数量；买方为 null。 */
  pendingInventoryQuantity: number | null;
  /** 撮合规则版本，可追溯价格—时间优先与成交价取 maker 的语义。 */
  ruleVersion: string;
  /**
   * I20B 待履约期限（UTC ISO 8601）。成交在到期前可由买卖任一方确认履约或取消履约；
   * 到期后由 order.expire 任务推进为取消履约，不再可操作。
   */
  fulfillmentDeadline: string;
  status: BilateralTradeStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TournamentResult {
  tournamentId: string;
  playerId: string;
  opponentName: string;
  format: string;
  winner: "player" | "opponent";
  highlights: string[];
  settledAt?: string;
}

export type TournamentStatus = "open" | "settling" | "settled" | "cancelled";
export type TournamentKind = "single" | "swiss" | "prereg";
export interface TournamentDto { id: string; templateId: string; naturalDate: string; kind: TournamentKind; totalSeats: number; entryFee: Money; difficulty: number; entryCondition: "valid_commander_deck"; dailyRegistrationLimit: number; startMode: "on_registration" | "at_cutoff"; opensAt: string; cutoffAt: string | null; status: TournamentStatus; ruleVersion: string; registered: boolean; createdAt: string; settledAt: string | null; }
export interface TournamentRegistrationDto { id: string; tournamentId: string; deckId: string; powerSnapshot: DeckPowerSnapshotDto; status: "registered" | "settled" | "eliminated"; registeredAt: string; }
export interface TournamentRewardDetailDto { kind: "GAME_CREDIT" | "pack" | "sku" | "none"; amount: number; packId: string | null; skuId: string | null; }
export interface TournamentSettlementDto { tournamentId: string; registrationId: string; rank: number; wins: number; draws: number; losses: number; byes: number; forfeits: number; points: number; reward: Money; rewardDetail: TournamentRewardDetailDto; ruleVersion: string; settledAt: string; replay: { seed: string; playerScore: number; npcScores: Array<{ id: string; score: number }>; swissCut: number; standings: Array<{ id: string; points: number; opponentPoints: number }>; rounds: Array<{ round: number; opponentName: string; outcome: "win" | "draw" | "loss" | "bye" | "forfeit"; stage: "single" | "swiss" | "elimination" | "playoff" }> }; }
/** 玩家自己的 NPC 已报名赛事历史；结果和重放均为服务端已结算投影。 */
export interface TournamentHistoryItemDto { tournament: TournamentDto; registration: TournamentRegistrationDto; result: TournamentSettlementDto | null; }

export interface PlayerTournamentDto { id: string; creatorUserId: string; mode: "game" | "tabletop"; name: string; status: "open" | "in_progress" | "settled" | "disputed" | "cancelled"; ruleVersion: string; createdAt: string; settledAt: string | null; }
export interface PlayerTournamentRegistrationDto { id: string; tournamentId: string; deckName: string; mode: "game" | "tabletop"; status: "registered" | "withdrawn" | "eliminated"; points: number; registeredAt: string; }
export interface PlayerTournamentRoundDto { id: string; tournamentId: string; roundNumber: number; tableNumber: number; stage: "normal" | "playoff"; status: "pending" | "submitted" | "confirmed" | "disputed"; registrationIds: string[]; submittedByUserId: string | null; confirmedAt: string | null; }
export interface PlayerTournamentResultDto { tournamentId: string; registrationId: string; rank: number; points: number; opponentPoints: number; reward: Money; rewardDetail: TournamentRewardDetailDto; settledAt: string; }

export interface NarrativePayload {
  headline: string;
  summary: string;
  highlights: string[];
  npcQuote: string;
  tone: "victory" | "defeat" | "tense" | "neutral";
}

/** I26B 成就：定义、进度、解锁与奖励只承载服务端已结算结果，浏览器不得自行解锁或发奖。 */
export type AchievementKindDto = "tournament" | "deck" | "collection";
export type AchievementRewardKindDto = "GAME_CREDIT" | "sku" | "badge";
export interface AchievementRewardDetailDto { kind: AchievementRewardKindDto; amount: number; packId: string | null; skuId: string | null; badgeId: string | null; }
export interface AchievementDisplayDto { title: string; description: string; badge: string | null; }
export interface AchievementDefinitionDto {
  id: string;
  kind: AchievementKindDto;
  category: string;
  goal: number;
  reward: AchievementRewardDetailDto;
  display: AchievementDisplayDto;
  hidden: boolean;
  ruleVersion: string;
}
export interface AchievementProgressDto {
  definitionId: string;
  currentValue: number;
  goalValue: number;
  status: "pending" | "unlocked";
  unlockedAt: string | null;
  /** 触发该次评估的 fact 事件 ID，用于来源反查；未评估时为 null。 */
  lastEvaluatedFactId: string | null;
}
/** 不可变解锁记录的来源摘要；前端可据此跳转到赛事或流水。 */
export interface AchievementUnlockSourceDto { type: "tournament.settled" | "collection"; factId: string | null; aggregateId: string | null; }
export interface AchievementUnlockDto {
  definitionId: string;
  source: AchievementUnlockSourceDto;
  ruleVersion: string;
  unlockedAt: string;
  reward: AchievementRewardDetailDto;
  /** 奖励实际发放状态；风控拦截不会撤销已达成的成就。 */
  rewardStatus: "granted" | "blocked";
  /** 关联账本/库存流水的 correlationId；徽章奖励为 unlockId 关联的审计入口。 */
  rewardCorrelationId: string | null;
}

/** I35B 每日/每周任务：定义、实例与领取结果只承载服务端已结算结果，浏览器不得判定进度或发放奖励。 */
export type TaskPeriodKindDto = "daily" | "weekly";
export type TaskMetricTypeDto = "pack.open" | "trade" | "npc.sell" | "collection.value" | "tournament.play" | "set.completion";
export type TaskInstanceStatusDto = "pending" | "claimable" | "claimed";
export interface TaskDefinitionDto {
  id: string;
  period: TaskPeriodKindDto;
  metricType: TaskMetricTypeDto;
  targetAmount: number;
  rewardAmount: number;
  title: string;
  description: string;
  ruleVersion: string;
}
export interface TaskInstanceDto {
  id: string;
  definitionId: string;
  period: TaskPeriodKindDto;
  periodKey: string;
  /** 定义展示字段随实例返回（只读展示，不作为判定依据）。 */
  title: string;
  description: string;
  metricType: TaskMetricTypeDto;
  currentValue: number;
  targetAmount: number;
  rewardAmount: number;
  status: TaskInstanceStatusDto;
  claimedAt: string | null;
}
/** 任务中心：今日 + 本周实例（含未创建实例的 0 进度空态）与可领取数。 */
export interface TaskCenterDto {
  daily: TaskInstanceDto[];
  weekly: TaskInstanceDto[];
  pendingRewardCount: number;
  /** 服务端自然日/周键，浏览器不得以本地日期推导周期。 */
  period: { day: string; week: string };
}
export interface TaskClaimDto {
  instanceId: string;
  status: TaskInstanceStatusDto;
  reward: Money;
  /** 领取后可用余额；浏览器只展示，不推导。 */
  balance: Money;
}

/** I35B 等级/声望：等级、经验与已解锁能力只由服务端计算与存储，浏览器只展示。 */
export interface GrowthCapabilitiesDto {
  /** 等级解锁的 NPC 每日交易额度倍数（等级 1 为 1）。 */
  npcDailyTradeMultiplier: number;
  /** 等级解锁的批量开包数量上限（等级 1 为 10）。 */
  bulkPackMax: number;
}
export interface GrowthProfileDto {
  level: number;
  title: string;
  totalXp: number;
  nextLevelXp: number | null;
  /** 当前级内进度 bp（0–10000）。 */
  progressBasisPoints: number;
  capabilities: GrowthCapabilitiesDto;
  /** 历史峰值净资产（服务端只增不减）。 */
  peakNetWorth: Money;
  ruleVersion: string;
  updatedAt: string;
}

/** I36B 新手引导：步骤与完成奖励只承载服务端已结算结果；浏览器不判定完成、不发放奖励。 */
export type OnboardingStepCompletionKindDto = "auto" | "skip";
export interface OnboardingStepDto {
  /** 稳定步骤 ID（引导目标链：领取资金/开包/看价/首笔交易/收藏/报名）。 */
  id: string;
  order: number;
  title: string;
  description: string;
  /** 前端目标功能入口；跳转只做导航，不改变完成状态。 */
  href: string;
  skippable: boolean;
  /** 完成方式：服务端按已结算事实/状态自动完成，或玩家显式跳过。 */
  completion: OnboardingStepCompletionKindDto | null;
  completedAt: string | null;
  skippedAt: string | null;
}
export type OnboardingRewardStatusDto = "unavailable" | "available" | "claimed";
export interface OnboardingDto {
  ruleVersion: string;
  steps: OnboardingStepDto[];
  completedCount: number;
  totalCount: number;
  allCompleted: boolean;
  /** 第一个未完成步骤（供前端高亮下一步）；全部完成时为 null。 */
  currentStepId: string | null;
  reward: {
    status: OnboardingRewardStatusDto;
    /** 固定的一次性奖励金额（规则版本确定）；浏览器只展示不推导。 */
    amount: Money;
    claimedAt: string | null;
  };
  updatedAt: string;
}
export interface OnboardingRewardClaimDto {
  status: OnboardingRewardStatusDto;
  reward: Money;
  /** 入账后可用余额；浏览器只展示，不推导。 */
  balance: Money;
  claimedAt: string;
}

export interface FactEvent<TType extends string, TPayload> {
  id: string;
  type: TType;
  version: 1;
  occurredAt: string;
  correlationId: string;
  payload: TPayload;
}

export interface PackOpenedPayload {
  userId: string;
  packId: string;
  packRuleVersion: string;
  spent: Money;
  received: Array<{ skuId: string; quantity: number }>;
}

export interface NpcTradeSettledPayload {
  tradeId: string;
  userId: string;
  skuId: string;
  side: "buy" | "sell";
  quantity: number;
  unitPrice: Money;
  total: Money;
  quoteVersion: string;
}

export interface P2pTradeSettledPayload {
  tradeId: string;
  buyOrderId: string;
  sellOrderId: string;
  buyerId: string;
  sellerId: string;
  skuId: string;
  quantity: number;
  unitPrice: Money;
  fees: FeeDto[];
}

export interface TournamentSettledPayload {
  tournamentId: string;
  playerId: string;
  result: "win" | "loss";
  reward: Money;
  ruleVersion: string;
  randomSeedHash: string;
}

export type PackOpenedEvent = FactEvent<"pack.opened", PackOpenedPayload>;
export type NpcTradeSettledEvent = FactEvent<"npc.trade.settled", NpcTradeSettledPayload>;
export type P2pTradeSettledEvent = FactEvent<"p2p.trade.settled", P2pTradeSettledPayload>;
export type TournamentSettledEvent = FactEvent<"tournament.settled", TournamentSettledPayload>;

export type EconomicFactEvent =
  | PackOpenedEvent
  | NpcTradeSettledEvent
  | P2pTradeSettledEvent
  | TournamentSettledEvent;

export type FactEventType =
  | "pack.opened"
  | "npc.trade.settled"
  | "p2p.trade.settled"
  | "tournament.settled";

// ---------------------------------------------------------------------------
// I30B 管理后台 DTO。所有管理路由要求 admin 角色；写路由要求 Idempotency-Key、
// 原因（适用时）、实体版本与不可变审计。日志与详情只返回脱敏字段，绝不暴露密码哈希、
// 令牌摘要、Cookie、密钥或未处理的 Provider 敏感输入。
// ---------------------------------------------------------------------------

/** 管理后台首页聚合：环境、目录/价格新鲜度、失败任务、活动、待复核异常与最近操作摘要。 */
export interface AdminDashboardDto {
  environment: "development" | "test" | "production";
  catalogFreshness: { updatedAt: string | null; status: "fresh" | "stale" | "unavailable" };
  priceFreshness: { updatedAt: string | null; status: "fresh" | "stale" | "unavailable" };
  failedJobCount: number;
  activeCampaignCount: number;
  pendingReviewExceptionCount: number;
  recentActions: AdminAuditLogDto[];
}

/** 脱敏后的审计日志条目；不包含密码、令牌、Cookie 或 Provider 原始响应。 */
export interface AdminAuditLogDto {
  id: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  requestId: string | null;
  occurredAt: string;
  /** 脱敏摘要；敏感字段已由写入方剔除。 */
  summary: Record<string, unknown>;
}

export interface AdminAuditLogDetailDto extends AdminAuditLogDto {
  /** 关联的近期同实体/同请求记录，便于串起一次操作链；不递归无限展开。 */
  relatedLogs: AdminAuditLogDto[];
}

export interface AdminAuditLogQuery {
  cursor?: string;
  limit?: number;
  from?: string;
  to?: string;
  actorId?: string;
  userId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  requestId?: string;
  taskType?: string;
}

/** 异常交易/待复核项：聚合 flagged 风控决策与失败任务，供管理员复核。 */
export interface AdminExceptionTradeDto {
  id: string;
  kind: "risk_flagged" | "failed_job";
  userId: string | null;
  entityType: string;
  entityId: string;
  reason: string;
  status: string;
  occurredAt: string;
  requestId: string | null;
}

export type CampaignStatus = "draft" | "previewing" | "published" | "paused" | "ended";
export type CampaignScopeType = "global" | "set" | "sku";
export type CampaignType = "market_factor";

export interface AdminCampaignDto {
  id: string;
  code: string;
  name: string;
  description: string | null;
  campaignType: CampaignType;
  scopeType: CampaignScopeType;
  scopeId: string | null;
  factorBps: number;
  displayText: string;
  startsAt: string;
  endsAt: string;
  status: CampaignStatus;
  version: number;
  publishedMarketEventId: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  pausedAt: string | null;
  endedAt: string | null;
}

export interface AdminCampaignVersionDto {
  id: string;
  campaignId: string;
  version: number;
  definition: Record<string, unknown>;
  statusSnapshot: CampaignStatus;
  createdBy: string | null;
  createdAt: string;
}

/** 活动发布前服务端预览：返回可确认的版本、目标范围、UTC 区间、参数上限/冲突与预计任务。 */
export interface AdminCampaignPreviewDto {
  campaign: AdminCampaignDto;
  previewVersion: number;
  conflicts: Array<{ campaignId: string; code: string; scopeType: CampaignScopeType; scopeId: string | null; startsAt: string; endsAt: string }>;
  factorBpsInRange: boolean;
  scheduledReprice: { triggerKey: string; runAfter: string } | null;
}

export interface AdminUserListItemDto {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  frozen: boolean;
  frozenReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminUserDetailDto extends AdminUserListItemDto {
  activeSessionCount: number;
  accountBalance: { currency: CurrencyCode; total: number; available: number; frozen: number } | null;
  recentAudit: AdminAuditLogDto[];
}

export interface AdminCompensationResultDto {
  userId: string;
  /** 新追加的账本流水 ID（余额补偿）或库存流水 ID（库存补偿）。 */
  ledgerEntryId: string | null;
  inventoryEntryId: string | null;
  newBalance: { currency: CurrencyCode; total: number; available: number; frozen: number } | null;
  newQuantity: { skuId: string; quantity: number; available: number; orderLocked: number; tournamentLocked: number } | null;
  auditId: string;
  reason: string;
}

/** 市场参数单例的只读投影；管理员可预览并经版本条件更新。 */
export interface AdminMarketParametersDto {
  ruleVersion: string;
  eurCentToGameCreditBps: number;
  minimumPrice: number;
  npcBuySpreadBps: number;
  npcSellSpreadBps: number;
  npcFeeBps: number;
  /** I34B：NPC 做市商倾向全局因素（5000–20000 bp），reprice 时写入报价 reason。 */
  npcBiasBps: number;
  npcBiasReason: string;
  version: number;
  updatedAt: string;
}

export interface AdminConfigVersionDto {
  /** 实体版本号，写操作须回传以检测并发冲突。 */
  version: number;
  updatedAt: string;
}

export type MtgjsonDraftKind = "setlist" | "set" | "sealed_product" | "booster";
export type MtgjsonDraftMappingStatus = "pending" | "mapped" | "missing" | "conflict";
export type MtgjsonDraftStatus = "draft" | "validated" | "published" | "discarded";

export interface MtgjsonImportDraftDto {
  id: string;
  draftKind: MtgjsonDraftKind;
  sourceVersion: string;
  sourceChecksumSha256: string | null;
  setCode: string | null;
  mappingStatus: MtgjsonDraftMappingStatus;
  status: MtgjsonDraftStatus;
  version: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 草稿预览：按本地 Scryfall 系列代码与 SKU 映射展示可导入、缺失与冲突项。 */
export interface MtgjsonImportDraftSummaryDto {
  draft: MtgjsonImportDraftDto;
  importableCount: number;
  missingCount: number;
  conflictCount: number;
  /** 仅展示摘要项，不含 Provider 原始响应或密钥。 */
  items: Array<{ setCode: string; name: string; status: "importable" | "missing" | "conflict"; detail: string | null }>;
}

export interface AdminPackRuleDraftDto {
  packId: string;
  version: number;
  definition: Record<string, unknown>;
  createdBy: string | null;
  createdAt: string;
}

/** 补充包规则发布前服务端预览：候选池/卡位/权重/工艺校验与版本预览。 */
export interface AdminPackRulePreviewDto {
  packId: string;
  previewVersion: number;
  slots: Array<{ id: string; draws: number; rarityProbabilities: Array<{ rarity: string; probabilityBasisPoints: number }> }>;
  candidatePoolSize: number;
  valid: boolean;
  issues: string[];
}

/** I31B 备份记录 DTO。不暴露源库绝对路径，浏览器只看到文件名与受控下载流。 */
export interface BackupRecordDto {
  id: string;
  kind: "scheduled" | "manual" | "predeploy";
  status: "running" | "succeeded" | "failed";
  backupFileName: string | null;
  sizeBytes: number | null;
  sqliteIntegrityOk: boolean | null;
  sha256: string | null;
  failureReason: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  requestId: string | null;
}

/** I31B 恢复演练结果 DTO：只读校验摘要，绝不覆盖运行库。 */
export interface BackupRestoreRehearsalDto {
  backupId: string;
  backupFileName: string;
  sqliteIntegrityOk: boolean;
  coreTablesPresent: boolean;
  sampleCounts: { users: number; accounts: number; inventoryHoldings: number; jobs: number };
}

/** I31B 玩家导出记录 DTO。文件路径不外泄；下载时服务端再次复核 ownership 防越权。 */
export interface ExportRecordDto {
  id: string;
  kind: "all";
  format: "csv" | "json";
  fileName: string;
  sizeBytes: number | null;
  status: "running" | "succeeded" | "failed" | "expired";
  failureReason: string | null;
  expiresAt: string;
  createdAt: string;
}

const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const idempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

export function isValidRequestId(value: string): boolean {
  return requestIdPattern.test(value);
}

export function isValidIdempotencyKey(value: string): boolean {
  return idempotencyKeyPattern.test(value);
}

export function isValidRequestFingerprint(value: string): boolean {
  return sha256Pattern.test(value);
}

export function isValidMoney(value: Money): boolean {
  return Number.isSafeInteger(value.amount) && value.amount >= 0;
}

/** 将不带歧义的 JSON 请求体序列化为稳定、可哈希的字节表示。 */
export function canonicalizeRequest(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("请求体不能包含非有限数字");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeRequest).join(",")}]`;
  }

  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new TypeError("请求体只能包含普通 JSON 对象");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeRequest(record[key])}`)
      .join(",")}}`;
  }

  throw new TypeError("请求体只能包含 JSON 值");
}
