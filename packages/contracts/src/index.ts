/**
 * 跨应用共享的 API、事件与幂等契约。
 *
 * 金额一律以最小货币单位的整数表达；所有时间均为 UTC ISO 8601 字符串。
 * 这里的事件只描述已经提交的业务事实，绝不能被当作结算命令消费。
 */

export const CONTRACTS_VERSION = "2026-07-29" as const;

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
  openedAt: string;
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
    "id" | "name" | "setCode" | "setName" | "collectorNumber" | "finish" | "imagePath" | "tradable"
  >;
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
    kind: "supply-demand" | "series-cycle" | "relation" | "event" | "liquidity";
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

/** I14F 市场列表的只读投影；价格、可交易资格和禁用原因均由 API 判定。 */
export interface MarketQuoteListItemDto {
  sku: Pick<CatalogSkuDto, "id" | "name" | "setCode" | "setName" | "collectorNumber" | "finish" | "rarity" | "imagePath">;
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
  orderCount: number;
}

export interface BilateralOrderBookDto {
  skuId: string;
  bids: BilateralOrderBookLevelDto[];
  asks: BilateralOrderBookLevelDto[];
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

export interface NarrativePayload {
  headline: string;
  summary: string;
  highlights: string[];
  npcQuote: string;
  tone: "victory" | "defeat" | "tense" | "neutral";
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
