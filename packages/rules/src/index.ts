/** I11B：概率、候选池和种子均为显式输入，规则包不访问 CSPRNG、数据库或环境变量。 */
export * from "./deck-rules.js";
export interface PackCandidate {
  skuId: string;
  weight: number;
}

export interface PackCandidatePool {
  id: string;
  rarity: string;
  candidates: PackCandidate[];
}

export interface PackSlotRule {
  id: string;
  draws: number;
  poolWeights: Array<{ poolId: string; weight: number }>;
}

export interface PackRuleInput {
  version: string;
  pools: PackCandidatePool[];
  slots: PackSlotRule[];
}

export interface PackOpenInput extends PackRuleInput {
  /** 由服务端 CSPRNG 生成；规则只将它转成确定性伪随机序列。 */
  randomSeed: string;
}

export interface PackOpenResult {
  ruleVersion: string;
  cards: Array<{ slotId: string; poolId: string; rarity: string; skuId: string }>;
}

export interface PackSlotProbability {
  slotId: string;
  draws: number;
  rarityProbabilities: Array<{ rarity: string; probabilityBasisPoints: number }>;
}

const MAX_WEIGHT_TOTAL = 0x1_0000_0000;

function positiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${label} 必须为正安全整数`);
}

function uniqueNonEmpty(values: string[], label: string): void {
  if (values.some((value) => value.trim().length === 0) || new Set(values).size !== values.length) throw new RangeError(`${label} 必须非空且唯一`);
}

function totalWeight(weights: number[], label: string): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (!Number.isSafeInteger(total) || total > MAX_WEIGHT_TOTAL) throw new RangeError(`${label} 总权重超出可重放范围`);
  return total;
}

/** 验证完整定义，并返回便于后续选择的池索引。 */
function validatePackRule(input: PackRuleInput): Map<string, PackCandidatePool> {
  if (input.version.trim().length === 0) throw new RangeError("补充包规则版本不能为空");
  if (input.pools.length === 0 || input.slots.length === 0) throw new RangeError("补充包必须至少包含一个候选池和一个卡位");
  uniqueNonEmpty(input.pools.map((pool) => pool.id), "候选池 ID");
  uniqueNonEmpty(input.slots.map((slot) => slot.id), "卡位 ID");
  const pools = new Map<string, PackCandidatePool>();
  for (const pool of input.pools) {
    if (pool.rarity.trim().length === 0 || pool.candidates.length === 0) throw new RangeError("候选池稀有度和候选卡不能为空");
    uniqueNonEmpty(pool.candidates.map((candidate) => candidate.skuId), `候选池 ${pool.id} 的 SKU`);
    for (const candidate of pool.candidates) positiveInteger(candidate.weight, `候选卡 ${candidate.skuId} 权重`);
    totalWeight(pool.candidates.map((candidate) => candidate.weight), `候选池 ${pool.id}`);
    pools.set(pool.id, pool);
  }
  for (const slot of input.slots) {
    positiveInteger(slot.draws, `卡位 ${slot.id} 抽取数量`);
    if (slot.poolWeights.length === 0) throw new RangeError(`卡位 ${slot.id} 必须关联至少一个候选池`);
    uniqueNonEmpty(slot.poolWeights.map((choice) => choice.poolId), `卡位 ${slot.id} 候选池`);
    for (const choice of slot.poolWeights) {
      positiveInteger(choice.weight, `卡位 ${slot.id} 候选池权重`);
      if (!pools.has(choice.poolId)) throw new RangeError(`卡位 ${slot.id} 引用了不存在的候选池 ${choice.poolId}`);
    }
    totalWeight(slot.poolWeights.map((choice) => choice.weight), `卡位 ${slot.id}`);
  }
  return pools;
}

/** 使用整数权重将一格概率转换成精确合计 10_000 bp 的服务端展示值。 */
export function packSlotProbabilities(input: PackRuleInput): PackSlotProbability[] {
  const pools = validatePackRule(input);
  return input.slots.map((slot) => {
    const byRarity = new Map<string, number>();
    for (const choice of slot.poolWeights) {
      const rarity = pools.get(choice.poolId)!.rarity;
      byRarity.set(rarity, (byRarity.get(rarity) ?? 0) + choice.weight);
    }
    const total = totalWeight([...byRarity.values()], `卡位 ${slot.id}`);
    const allocated = [...byRarity.entries()].map(([rarity, weight]) => ({ rarity, base: Math.floor((weight * 10_000) / total), remainder: (weight * 10_000) % total }));
    let remaining = 10_000 - allocated.reduce((sum, entry) => sum + entry.base, 0);
    allocated.sort((left, right) => right.remainder - left.remainder || left.rarity.localeCompare(right.rarity));
    const probabilityByRarity = new Map(allocated.map((entry) => [entry.rarity, entry.base]));
    for (let index = 0; remaining > 0; index = (index + 1) % allocated.length, remaining -= 1) {
      probabilityByRarity.set(allocated[index]!.rarity, probabilityByRarity.get(allocated[index]!.rarity)! + 1);
    }
    return { slotId: slot.id, draws: slot.draws, rarityProbabilities: [...probabilityByRarity.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([rarity, probabilityBasisPoints]) => ({ rarity, probabilityBasisPoints })) };
  });
}

function seedToState(seed: string): number {
  let state = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    state ^= seed.charCodeAt(index);
    state = Math.imul(state, 0x01000193);
  }
  return state >>> 0 || 0x6d2b79f5;
}

/** Mulberry32：只承担确定性重放，安全随机性由 API 的 CSPRNG 提供。 */
function seededRandom(seed: string): () => number {
  let state = seedToState(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function chooseByWeight<T extends { weight: number }>(values: T[], random: () => number): T {
  const total = totalWeight(values.map((value) => value.weight), "随机选择");
  let cursor = Math.floor(random() * total);
  for (const value of values) {
    if (cursor < value.weight) return value;
    cursor -= value.weight;
  }
  return values[values.length - 1]!;
}

/** 以相同规则输入和种子产生相同顺序的 SKU 结果，且不会变更输入对象。 */
export function openPack(input: PackOpenInput): PackOpenResult {
  if (input.randomSeed.trim().length === 0) throw new RangeError("随机种子不能为空");
  const pools = validatePackRule(input);
  const random = seededRandom(input.randomSeed);
  const cards: PackOpenResult["cards"] = [];
  for (const slot of input.slots) {
    for (let draw = 0; draw < slot.draws; draw += 1) {
      const selectedPoolWeight = chooseByWeight(slot.poolWeights, random);
      const pool = pools.get(selectedPoolWeight.poolId)!;
      const candidate = chooseByWeight(pool.candidates, random);
      cards.push({ slotId: slot.id, poolId: pool.id, rarity: pool.rarity, skuId: candidate.skuId });
    }
  }
  return { ruleVersion: input.version, cards };
}

/** I07 初始资金规则：金额为整数最小单位，规则版本会写入每一份新存档。 */
export const INITIAL_FUNDING_RULE_VERSION = "v1" as const;
export const INITIAL_FUNDING = { amount: 10_000, currency: "GAME_CREDIT" as const };

export function resolveInitialFunding(version: string): typeof INITIAL_FUNDING {
  if (version !== INITIAL_FUNDING_RULE_VERSION) {
    throw new RangeError(`不支持的初始资金规则版本：${version}`);
  }
  return INITIAL_FUNDING;
}

/** I23B：每日工作资金只能由服务端按已快照的规则版本发放。 */
export const DAILY_WORK_FUNDING_RULE_VERSION = "daily-work-funds/v1" as const;
export const DAILY_WORK_FUNDING = { amount: 1_000, currency: "GAME_CREDIT" as const };
/** 已发布的后续示例版本用于验证配置切换不会改写已开放自然日。 */
export const DAILY_WORK_FUNDING_RULE_VERSION_V2 = "daily-work-funds/v2" as const;
export const DAILY_WORK_FUNDING_V2 = { amount: 1_200, currency: "GAME_CREDIT" as const };

/**
 * 规则包只解析版本化的固定输入；自然日、时区、用户资格和幂等由 API 的 application
 * 用例负责，避免把运行时配置或数据库依赖带入可重放规则。
 */
export function resolveDailyWorkFunding(version: string): typeof DAILY_WORK_FUNDING {
  if (version === DAILY_WORK_FUNDING_RULE_VERSION) return DAILY_WORK_FUNDING;
  if (version === DAILY_WORK_FUNDING_RULE_VERSION_V2) return DAILY_WORK_FUNDING_V2;
  throw new RangeError(`不支持的每日工作资金规则版本：${version}`);
}

/** I14B：市场规则的所有金额与系数均为整数，避免浮点结算漂移。 */
export const MARKET_RULE_VERSION = "market/v1" as const;
export const MARKET_FACTOR_MIN_BPS = 5_000;
export const MARKET_FACTOR_MAX_BPS = 20_000;
/** 报价快照只可在短窗口内确认，避免浏览器长期持有旧报价。 */
export const MARKET_QUOTE_VALIDITY_MS = 15 * 60 * 1_000;

export interface MarketFactorInput {
  kind: "supply-demand" | "series-cycle" | "relation" | "event" | "liquidity";
  /** 10_000 代表不影响报价；每项先校验，再在总和阶段统一截断。 */
  factorBasisPoints: number;
  reason: string;
}

export interface MarketQuoteRuleInput {
  version: string;
  /** Cardmarket EUR 最小单位（欧分）。 */
  referencePriceEurCents: number;
  /** 一欧分兑换的游戏币，使用 bp 表示；10_000 即 1:1。 */
  eurCentToGameCreditBasisPoints: number;
  minimumPrice: number;
  npcBuySpreadBasisPoints: number;
  npcSellSpreadBasisPoints: number;
  npcFeeBasisPoints: number;
  factors: MarketFactorInput[];
}

export interface MarketQuoteRuleResult {
  ruleVersion: string;
  referencePriceEurCents: number;
  marketFactorBasisPoints: number;
  marketPrice: number;
  npcBuyPrice: number;
  npcSellPrice: number;
  npcBuyFee: number;
  npcSellFee: number;
  reasons: Array<{ kind: MarketFactorInput["kind"]; factorBasisPoints: number; reason: string }>;
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} 必须为非负安全整数`);
}

function basisPoints(value: number, label: string, minimum = 0, maximum = 100_000): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} 必须在 ${minimum} 到 ${maximum} bp 之间`);
}

/** 非负整数的 half-up 除法；输入受安全整数边界保护。 */
function divideHalfUp(numerator: number, denominator: number, label: string): number {
  if (!Number.isSafeInteger(numerator) || numerator < 0 || !Number.isSafeInteger(denominator) || denominator <= 0) throw new RangeError(`${label} 计算输入无效`);
  const result = Math.floor((numerator + Math.floor(denominator / 2)) / denominator);
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} 超出安全整数范围`);
  return result;
}

/**
 * 纯、版本化且可重放的报价计算。先将 EUR 锚点转换为游戏币，再叠加受界因素；
 * NPC 价差和费用只影响游戏内成交报价，绝不修改外部参考价。
 */
export function calculateMarketQuote(input: MarketQuoteRuleInput): MarketQuoteRuleResult {
  if (input.version !== MARKET_RULE_VERSION) throw new RangeError(`不支持的市场规则版本：${input.version}`);
  positiveInteger(input.referencePriceEurCents, "外部参考价");
  basisPoints(input.eurCentToGameCreditBasisPoints, "EUR 兑换率", 1, 1_000_000);
  nonNegativeSafeInteger(input.minimumPrice, "最低报价");
  basisPoints(input.npcBuySpreadBasisPoints, "NPC 买入价差", 0, 9_999);
  basisPoints(input.npcSellSpreadBasisPoints, "NPC 卖出价差", 0, 100_000);
  basisPoints(input.npcFeeBasisPoints, "NPC 费用", 0, 100_000);
  if (input.factors.length === 0) throw new RangeError("市场报价必须包含至少一个系数");

  let rawFactor = 10_000;
  for (const factor of input.factors) {
    basisPoints(factor.factorBasisPoints, `${factor.kind} 系数`, MARKET_FACTOR_MIN_BPS, MARKET_FACTOR_MAX_BPS);
    if (!factor.reason.trim()) throw new RangeError("市场系数必须记录计算原因");
    rawFactor += factor.factorBasisPoints - 10_000;
  }
  const marketFactorBasisPoints = Math.min(MARKET_FACTOR_MAX_BPS, Math.max(MARKET_FACTOR_MIN_BPS, rawFactor));
  const converted = divideHalfUp(input.referencePriceEurCents * input.eurCentToGameCreditBasisPoints, 10_000, "EUR 兑换");
  const marketPrice = Math.max(input.minimumPrice, divideHalfUp(converted * marketFactorBasisPoints, 10_000, "游戏内中间价"));
  const npcBuyFee = divideHalfUp(marketPrice * input.npcFeeBasisPoints, 10_000, "NPC 买入费用");
  const npcSellFee = divideHalfUp(marketPrice * input.npcFeeBasisPoints, 10_000, "NPC 卖出费用");
  const npcBuyPrice = Math.max(input.minimumPrice, Math.floor((marketPrice * (10_000 - input.npcBuySpreadBasisPoints)) / 10_000) - npcBuyFee);
  const npcSellPrice = Math.max(input.minimumPrice, divideHalfUp(marketPrice * (10_000 + input.npcSellSpreadBasisPoints), 10_000, "NPC 卖出价") + npcSellFee);
  return {
    ruleVersion: input.version,
    referencePriceEurCents: input.referencePriceEurCents,
    marketFactorBasisPoints,
    marketPrice,
    npcBuyPrice,
    npcSellPrice,
    npcBuyFee,
    npcSellFee,
    reasons: input.factors.map(({ kind, factorBasisPoints, reason }) => ({ kind, factorBasisPoints, reason }))
  };
}

/** 将已结算的源 SKU 压力按关联权重传播，输出仍是可受界的 bp 系数。 */
export function propagateMarketPressure(sourcePressure: number, relationWeightBasisPoints: number): number {
  if (!Number.isSafeInteger(sourcePressure)) throw new RangeError("关联压力必须为安全整数");
  basisPoints(relationWeightBasisPoints, "关联权重", 0, 10_000);
  const adjustment = Math.trunc((sourcePressure * relationWeightBasisPoints) / 10_000) * 25;
  return Math.min(MARKET_FACTOR_MAX_BPS, Math.max(MARKET_FACTOR_MIN_BPS, 10_000 + adjustment));
}

/** 市场报价的有效期由计算时间和版本化固定窗口确定，不依赖外部快照的采集时刻。 */
export function marketQuoteValidUntil(version: string, calculatedAt: string): string {
  if (version !== MARKET_RULE_VERSION) throw new RangeError(`不支持的市场规则版本：${version}`);
  const timestamp = Date.parse(calculatedAt);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== calculatedAt)
    throw new RangeError("报价计算时间必须是 UTC ISO 8601");
  return new Date(timestamp + MARKET_QUOTE_VALIDITY_MS).toISOString();
}

/**
 * I18B：双边委托限价范围、费用与保证金的纯规则。所有金额均为整数最小货币单位，
 * 系数以 bp 表达；买单预占 数量*限价+order_fee，卖单只预占 fulfillment_deposit，
 * order_fee 留到 I19B/I20B 撮合/履约时从卖方收入扣除（与 NPC 卖出一致）。
 */
export const ORDER_RULE_VERSION = "order/v1" as const;
/** 委托预览与报价版本变化绑定；版本不一致必须重新预览，浏览器不得长期持有旧值。 */
export const ORDER_PREVIEW_VERSION = "order-preview/v1" as const;

export interface OrderLimitBandInput {
  marketPrice: number;
  minimumPrice: number;
  /** 10_000 = 1:1，5000 = ±50%。 */
  limitPriceBandBasisPoints: number;
}

export interface OrderLimitBand {
  ruleVersion: string;
  marketPrice: number;
  min: number;
  max: number;
}

export interface OrderFeeInput {
  side: "buy" | "sell";
  quantity: number;
  /** 玩家确认的单位限价。 */
  limitPrice: number;
  /** 锚点市场中间价；仅用于按 bp 计算 order_fee 与 fulfillment_deposit。 */
  marketPrice: number;
  orderFeeBasisPoints: number;
  fulfillmentDepositBasisPoints: number;
  minimumPrice: number;
}

export interface OrderFeeResult {
  ruleVersion: string;
  /** 单位手续费（按市场价计算），整数最小货币单位。 */
  unitFee: number;
  /** 单位模拟履约保证金（按市场价计算），整数最小货币单位。 */
  unitFulfillmentDeposit: number;
  /** 全部数量的手续费；买单会预占，卖单仅在 I19B/I20B 履约时扣除。 */
  orderFee: number;
  /** 全部数量的保证金；卖单创建时全额预占。 */
  fulfillmentDeposit: number;
  /**
   * 委托阶段实际预占的资金：买单=数量*限价+order_fee；卖单=fulfillmentDeposit。
   * 不接受客户端自报该值。
   */
  reservedFunds: number;
  /** 买单=数量*限价（预计支出）；卖单=数量*限价（预计到手，未扣 order_fee）。 */
  estimatedAmount: number;
}

/** 校验限价是否落在服务端计算的有效带内；返回显式结果，绝不静默回退。 */
export function resolveOrderLimitBand(input: OrderLimitBandInput): OrderLimitBand {
  nonNegativeSafeInteger(input.marketPrice, "市场中间价");
  nonNegativeSafeInteger(input.minimumPrice, "最低报价");
  basisPoints(input.limitPriceBandBasisPoints, "限价带宽度", 0, 100_000);
  const min = Math.max(input.minimumPrice, divideHalfUp(input.marketPrice * (10_000 - input.limitPriceBandBasisPoints), 10_000, "限价下限"));
  const max = divideHalfUp(input.marketPrice * (10_000 + input.limitPriceBandBasisPoints), 10_000, "限价上限");
  if (min > max) throw new RangeError("限价带宽度配置导致下限大于上限");
  return { ruleVersion: ORDER_RULE_VERSION, marketPrice: input.marketPrice, min, max };
}

/** 校验限价是否落在有效带内；越界返回 false 而不抛错，由调用方决定错误语义。 */
export function isWithinOrderLimitBand(limitPrice: number, band: OrderLimitBand): boolean {
  if (!Number.isSafeInteger(limitPrice) || limitPrice < 0) return false;
  return limitPrice >= band.min && limitPrice <= band.max;
}

/** 按 bp 与数量计算费用与预占资金；reservedFunds 与 estimatedAmount 均由服务端计算，不接受客户端自报。 */
export function calculateOrderFees(input: OrderFeeInput): OrderFeeResult {
  positiveInteger(input.quantity, "委托数量");
  nonNegativeSafeInteger(input.limitPrice, "限价");
  nonNegativeSafeInteger(input.marketPrice, "市场中间价");
  nonNegativeSafeInteger(input.minimumPrice, "最低报价");
  basisPoints(input.orderFeeBasisPoints, "订单手续费率", 0, 100_000);
  basisPoints(input.fulfillmentDepositBasisPoints, "模拟履约保证金率", 0, 100_000);
  const unitFee = Math.max(input.minimumPrice, divideHalfUp(input.marketPrice * input.orderFeeBasisPoints, 10_000, "单位手续费"));
  const unitFulfillmentDeposit = Math.max(input.minimumPrice, divideHalfUp(input.marketPrice * input.fulfillmentDepositBasisPoints, 10_000, "单位保证金"));
  const orderFee = multiplySafe(unitFee, input.quantity, "订单手续费");
  const fulfillmentDeposit = multiplySafe(unitFulfillmentDeposit, input.quantity, "模拟履约保证金");
  const estimatedAmount = multiplySafe(input.limitPrice, input.quantity, "委托金额");
  const reservedFunds = input.side === "buy" ? addSafe(estimatedAmount, orderFee, "买单预占资金") : fulfillmentDeposit;
  return {
    ruleVersion: ORDER_RULE_VERSION,
    unitFee,
    unitFulfillmentDeposit,
    orderFee,
    fulfillmentDeposit,
    reservedFunds,
    estimatedAmount
  };
}

/** 校验取消条件：仅 open/partially_filled 可撤；其余状态返回显式错误。 */
export type OrderCancelResult = { ok: true; currentStatus: "open" | "partially_filled" } | { ok: false; reason: "not_cancellable" };

export function validateOrderCancellation(currentStatus: string): OrderCancelResult {
  if (currentStatus === "open" || currentStatus === "partially_filled") return { ok: true, currentStatus };
  return { ok: false, reason: "not_cancellable" };
}

function multiplySafe(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) throw new RangeError(`${label} 输入必须是非负安全整数`);
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} 超出安全整数范围`);
  return result;
}

function addSafe(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) throw new RangeError(`${label} 输入必须是非负安全整数`);
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError(`${label} 超出安全整数范围`);
  return result;
}

/**
 * I19B：双边委托撮合纯规则。价格—时间优先、成交价取 maker、部分成交、剩余数量与自成交
 * 拒绝均在此确定；服务端只把已结算 legs 落库为 bilateral_trades，不在此修改经济真相。
 * 规则不依赖数据库、HTTP 或随机源，相同输入必产生相同输出。
 */
export const ORDER_MATCH_RULE_VERSION = "order-matching/v1" as const;

/** 自成交校验：买卖双方为同一用户时拒绝撮合，避免刷量与操纵。 */
export type SelfTradeCheckResult = { ok: true } | { ok: false; reason: "self_trade" };

export function checkSelfTrade(buyerUserId: string, sellerUserId: string): SelfTradeCheckResult {
  if (buyerUserId.trim().length === 0 || sellerUserId.trim().length === 0) throw new RangeError("自成交校验的用户不能为空");
  return buyerUserId === sellerUserId ? { ok: false, reason: "self_trade" } : { ok: true };
}

/** 参与撮合的单条委托投影；sequence 为服务端单调序，保证 createdAt 并列时仍稳定可重放。 */
export interface MatchOrderInput {
  id: string;
  userId: string;
  /** 单位限价，整数最小货币单位。 */
  limitPrice: number;
  remainingQuantity: number;
  /** 创建时刻 UTC ISO 8601；用于确定 maker（先入订单簿一方）。 */
  createdAt: string;
  /** 服务端单调序；createdAt 相同时以 sequence 决定先后。 */
  sequence: number;
}

/** 单笔撮合结果；每条对应一行 bilateral_trades。 */
export interface MatchLeg {
  buyOrderId: string;
  sellOrderId: string;
  buyerUserId: string;
  sellerUserId: string;
  buyLimitPrice: number;
  sellLimitPrice: number;
  /** 取 maker（先入订单簿一方）限价；买卖同时入则以 sequence 较小者为 maker。 */
  executionPrice: number;
  quantity: number;
  ruleVersion: string;
}

export interface MatchOrdersInput {
  ruleVersion: string;
  /** 仅用于校验；撮合本身不改写该值。 */
  minimumPrice: number;
  buyOrders: MatchOrderInput[];
  sellOrders: MatchOrderInput[];
}

export interface MatchOrdersResult {
  ruleVersion: string;
  legs: MatchLeg[];
  /** 撮合后每条委托的剩余数量（仅含输入中出现的 orderId）。 */
  remaining: Record<string, number>;
  /** 因自成交被跳过的委托对，供服务端审计与风控复核。 */
  skippedSelfTrade: Array<{ buyOrderId: string; sellOrderId: string }>;
}

/** 校验单条委托投影；空 id/用户、负价或负量、坏时间或非安全整数均拒绝。 */
function validateMatchOrder(order: MatchOrderInput, label: string): void {
  if (order.id.trim().length === 0) throw new RangeError(`${label} id 不能为空`);
  if (order.userId.trim().length === 0) throw new RangeError(`${label} 用户不能为空`);
  nonNegativeSafeInteger(order.limitPrice, `${label} 限价`);
  if (!Number.isSafeInteger(order.remainingQuantity) || order.remainingQuantity <= 0) throw new RangeError(`${label} 剩余数量必须为正整数`);
  if (!Number.isSafeInteger(order.sequence) || order.sequence < 0) throw new RangeError(`${label} 序号必须为非负安全整数`);
  const parsed = Date.parse(order.createdAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== order.createdAt) throw new RangeError(`${label} 创建时间必须是 UTC ISO 8601`);
}

/**
 * 价格—时间优先撮合。买单按「限价降序、序号升序」，卖单按「限价升序、序号升序」；
 * 双游标逐对推进，当买限价 >= 卖限价时以 maker 价成交 min(买余量, 卖余量)；自成交跳过
 * 并继续推进。算法纯且可重放：相同输入恒产生相同 legs/remaining/skippedSelfTrade。
 */
export function matchOrders(input: MatchOrdersInput): MatchOrdersResult {
  if (input.ruleVersion !== ORDER_MATCH_RULE_VERSION) throw new RangeError(`不支持的撮合规则版本：${input.ruleVersion}`);
  nonNegativeSafeInteger(input.minimumPrice, "最低报价");
  if (input.buyOrders.length === 0 || input.sellOrders.length === 0) return { ruleVersion: input.ruleVersion, legs: [], remaining: {}, skippedSelfTrade: [] };
  for (const order of input.buyOrders) validateMatchOrder(order, "买单");
  for (const order of input.sellOrders) validateMatchOrder(order, "卖单");

  const buyIds = new Set(input.buyOrders.map((order) => order.id));
  for (const order of input.sellOrders) {
    if (buyIds.has(order.id)) throw new RangeError("买卖委托 id 必须唯一");
  }

  const buys = [...input.buyOrders].sort((left, right) => right.limitPrice - left.limitPrice || left.sequence - right.sequence);
  const sells = [...input.sellOrders].sort((left, right) => left.limitPrice - right.limitPrice || left.sequence - right.sequence);

  const legs: MatchLeg[] = [];
  const skippedSelfTrade: MatchOrdersResult["skippedSelfTrade"] = [];
  const remaining: Record<string, number> = {};
  for (const order of input.buyOrders) remaining[order.id] = order.remainingQuantity;
  for (const order of input.sellOrders) remaining[order.id] = order.remainingQuantity;

  let buyIndex = 0;
  let sellIndex = 0;
  while (buyIndex < buys.length && sellIndex < sells.length) {
    const buy = buys[buyIndex]!;
    const sell = sells[sellIndex]!;
    if (buy.limitPrice < sell.limitPrice) break; // 最佳买价已低于最佳卖价，订单簿无更多可成交对。

    if (buy.userId === sell.userId) {
      skippedSelfTrade.push({ buyOrderId: buy.id, sellOrderId: sell.id });
      // 自成交双方均仍有剩余且可能匹配其他对手盘：按 maker（先入者）推进游标，
      // 避免无限循环；同时保留另一侧继续与其他对手盘撮合的机会。
      if (isMaker(buy, sell)) buyIndex += 1;
      else sellIndex += 1;
      continue;
    }

    const quantity = Math.min(remaining[buy.id] ?? 0, remaining[sell.id] ?? 0);
    if (quantity <= 0) break;
    const executionPrice = makerPrice(buy, sell);
    if (executionPrice < input.minimumPrice) throw new RangeError("撮合成交价低于最低报价");
    legs.push({ buyOrderId: buy.id, sellOrderId: sell.id, buyerUserId: buy.userId, sellerUserId: sell.userId, buyLimitPrice: buy.limitPrice, sellLimitPrice: sell.limitPrice, executionPrice, quantity, ruleVersion: input.ruleVersion });
    remaining[buy.id] = (remaining[buy.id] ?? 0) - quantity;
    remaining[sell.id] = (remaining[sell.id] ?? 0) - quantity;
    if ((remaining[buy.id] ?? 0) === 0) buyIndex += 1;
    if ((remaining[sell.id] ?? 0) === 0) sellIndex += 1;
  }

  return { ruleVersion: input.ruleVersion, legs, remaining, skippedSelfTrade };
}

/** maker（先入订单簿一方）判定；createdAt 相同时以 sequence 较小者为 maker。 */
function isMaker(buy: MatchOrderInput, sell: MatchOrderInput): boolean {
  if (buy.createdAt < sell.createdAt) return true;
  if (buy.createdAt > sell.createdAt) return false;
  return buy.sequence <= sell.sequence;
}

/** 成交价取 maker 限价：buy 为 maker 取买限价，否则取卖限价。 */
function makerPrice(buy: MatchOrderInput, sell: MatchOrderInput): number {
  return isMaker(buy, sell) ? buy.limitPrice : sell.limitPrice;
}

/**
 * I20B：模拟履约纯规则。成交价、收入与保证金的实际金额全部从服务端的成交事实字段读取，
 * 规则只负责派生待履约期限（沿用委托有效期 ttl_seconds）与校验履约/取消/到期的状态前置，
 * 避免把可结算语义复制到 API、前端或 AI。纯函数、显式校验、可重放。
 */
export const ORDER_FULFILLMENT_RULE_VERSION = "order-fulfillment/v1" as const;

/**
 * 从撮合时刻与委托有效期派生待履约期限。沿用 bilateral_order_limits.ttl_seconds，使
 * 履约窗口与委托有效期语义一致；到期由 order.expire 把成交推进为取消履约。
 */
export function resolveFulfillmentDeadline(ruleVersion: string, ttlSeconds: number, matchedAt: string): string {
  if (ruleVersion !== ORDER_FULFILLMENT_RULE_VERSION) throw new RangeError(`不支持的履约规则版本：${ruleVersion}`);
  positiveInteger(ttlSeconds, "委托有效期秒数");
  const parsed = Date.parse(matchedAt);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== matchedAt) throw new RangeError("撮合时刻必须是 UTC ISO 8601");
  return new Date(parsed + ttlSeconds * 1_000).toISOString();
}

/** 履约前置状态：仅 `matched_pending_fulfillment` 可确认履约；fulfilled/cancelled 返回显式错误。 */
export type TradeFulfillmentResult = { ok: true; currentStatus: "matched_pending_fulfillment" } | { ok: false; reason: "not_fulfillable" };

export function validateTradeFulfillment(currentStatus: string): TradeFulfillmentResult {
  if (currentStatus === "matched_pending_fulfillment") return { ok: true, currentStatus };
  return { ok: false, reason: "not_fulfillable" };
}

/** 取消履约前置状态：仅 `matched_pending_fulfillment` 可取消履约；fulfilled/cancelled 返回显式错误。 */
export type TradeCancellationResult = { ok: true; currentStatus: "matched_pending_fulfillment" } | { ok: false; reason: "not_cancellable" };

export function validateTradeCancellation(currentStatus: string): TradeCancellationResult {
  if (currentStatus === "matched_pending_fulfillment") return { ok: true, currentStatus };
  return { ok: false, reason: "not_cancellable" };
}

/** 判断成交是否已到待履约期限；逾期可由 order.expire 推进为取消履约。 */
export function isFulfillmentOverdue(ruleVersion: string, fulfillmentDeadline: string, now: string): boolean {
  if (ruleVersion !== ORDER_FULFILLMENT_RULE_VERSION) throw new RangeError(`不支持的履约规则版本：${ruleVersion}`);
  const deadline = Date.parse(fulfillmentDeadline);
  const current = Date.parse(now);
  if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== fulfillmentDeadline) throw new RangeError("待履约期限必须是 UTC ISO 8601");
  if (!Number.isFinite(current) || new Date(current).toISOString() !== now) throw new RangeError("当前时间必须是 UTC ISO 8601");
  return fulfillmentDeadline <= now;
}

/** I21B：订单风控纯规则；配置、历史计数和潜在自成交均由 API 明确输入。 */
export const ORDER_RISK_RULE_VERSION = "order-risk/v1" as const;
export type OrderRiskReason = "price_out_of_band" | "cooldown" | "order_frequency" | "quantity_limit" | "self_trade" | "cancellation_frequency";
export interface OrderRiskConfig { maxQuantityPerOrder: number; maxQuantityPerUserSkuDay: number; limitPriceBandBasisPoints: number; orderCooldownSeconds: number; maxOrdersPerWindow: number; maxCancellationsPerWindow: number; reviewScoreThreshold: number; }
export interface OrderRiskInput { ruleVersion: string; quantity: number; limitPrice: number; band: OrderLimitBand; quantityToday: number; ordersInWindow: number; secondsSinceLastOrder: number | null; crossesOwnOppositeOrder: boolean; config: OrderRiskConfig; }
export interface OrderRiskResult { ruleVersion: string; outcome: "allowed" | "blocked" | "flagged"; score: number; reasons: OrderRiskReason[]; }
export function evaluateOrderRisk(input: OrderRiskInput): OrderRiskResult {
  if (input.ruleVersion !== ORDER_RISK_RULE_VERSION) throw new RangeError(`不支持的订单风控规则版本：${input.ruleVersion}`);
  positiveInteger(input.quantity, "风控委托数量"); nonNegativeSafeInteger(input.quantityToday, "当日委托数量"); nonNegativeSafeInteger(input.ordersInWindow, "窗口委托次数");
  for (const [value, label] of [[input.config.maxQuantityPerOrder, "单笔数量上限"], [input.config.maxQuantityPerUserSkuDay, "单日数量上限"], [input.config.maxOrdersPerWindow, "窗口次数上限"], [input.config.reviewScoreThreshold, "复核分数阈值"]] as const) positiveInteger(value, label);
  nonNegativeSafeInteger(input.config.orderCooldownSeconds, "下单冷却"); basisPoints(input.config.limitPriceBandBasisPoints, "风控限价带", 0, 100_000);
  if (input.secondsSinceLastOrder !== null) nonNegativeSafeInteger(input.secondsSinceLastOrder, "距上次下单秒数");
  const reasons: OrderRiskReason[] = [];
  if (!isWithinOrderLimitBand(input.limitPrice, input.band)) reasons.push("price_out_of_band");
  if (input.quantity > input.config.maxQuantityPerOrder || input.quantityToday + input.quantity > input.config.maxQuantityPerUserSkuDay) reasons.push("quantity_limit");
  if (input.ordersInWindow >= input.config.maxOrdersPerWindow) reasons.push("order_frequency");
  if (input.secondsSinceLastOrder !== null && input.secondsSinceLastOrder < input.config.orderCooldownSeconds) reasons.push("cooldown");
  if (input.crossesOwnOppositeOrder) reasons.push("self_trade");
  const weights: Record<OrderRiskReason, number> = { price_out_of_band: 80, quantity_limit: 50, order_frequency: 60, cooldown: 30, self_trade: 100, cancellation_frequency: 60 };
  const score = reasons.reduce((sum, reason) => sum + weights[reason], 0);
  return { ruleVersion: input.ruleVersion, outcome: reasons.length === 0 ? "allowed" : "blocked", score, reasons };
}
export function evaluateCancellationRisk(input: { ruleVersion: string; cancellationsInWindow: number; config: Pick<OrderRiskConfig, "maxCancellationsPerWindow" | "reviewScoreThreshold"> }): OrderRiskResult {
  if (input.ruleVersion !== ORDER_RISK_RULE_VERSION) throw new RangeError(`不支持的订单风控规则版本：${input.ruleVersion}`);
  nonNegativeSafeInteger(input.cancellationsInWindow, "窗口撤单次数"); positiveInteger(input.config.maxCancellationsPerWindow, "撤单次数上限"); positiveInteger(input.config.reviewScoreThreshold, "复核分数阈值");
  const flagged = input.cancellationsInWindow >= input.config.maxCancellationsPerWindow;
  return { ruleVersion: input.ruleVersion, outcome: flagged ? "flagged" : "allowed", score: flagged ? input.config.reviewScoreThreshold : 0, reasons: flagged ? ["cancellation_frequency"] : [] };
}
export * from "./local-deck-power.js";
export * from "./deck-feature-tags.js";
export * from "./tournament-rules.js";
