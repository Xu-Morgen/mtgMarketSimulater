/**
 * 跨应用共享的 API、事件与幂等契约。
 *
 * 金额一律以最小货币单位的整数表达；所有时间均为 UTC ISO 8601 字符串。
 * 这里的事件只描述已经提交的业务事实，绝不能被当作结算命令消费。
 */

export const CONTRACTS_VERSION = "2026-07-24" as const;

export type CurrencyCode = "EUR" | "GAME_CREDIT";
export type PriceSource = "mtgjson-cardmarket" | "manual-test";
export type Role = "player" | "admin";
export type CardFinish = "nonfoil" | "foil" | "etched";
/** 目录资料的来源；人工例外不得伪装成外部同步资料或价格。 */
export type CatalogSource = "scryfall" | "manual-test";
export type InventoryLockReason = "order" | "tournament";
export type OrderSide = "buy" | "sell";
export type OrderStatus =
  | "open"
  | "partially_filled"
  | "matched_pending_fulfillment"
  | "fulfilled"
  | "cancelled"
  | "expired";
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

export interface InventoryDto {
  skuId: string;
  quantity: number;
  availableQuantity: number;
  orderLockedQuantity: number;
  tournamentLockedQuantity: number;
  averageCost: Money;
  marketValue: Money | null;
  updatedAt: string;
}

export interface AccountBalanceDto {
  /** total = available + frozen，三个值均以整数最小单位表达。 */
  total: Money;
  available: Money;
  frozen: Money;
  updatedAt: string;
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
  skuId: string;
  quoteVersion: string;
  referencePrice: Money | null;
  marketPrice: Money;
  npcBuyPrice: Money;
  npcSellPrice: Money;
  validUntil: string;
  source: PriceSource | null;
  capturedAt: string;
}

/** 不可变外部参考价快照；游戏内报价使用 QuoteDto 表达。 */
export interface PriceSnapshot {
  skuId: string;
  source: PriceSource;
  sourcePrice: Money;
  capturedAt: string;
  sourceVersion: string;
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
