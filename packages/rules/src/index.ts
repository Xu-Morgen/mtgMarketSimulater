/** I11B：概率、候选池和种子均为显式输入，规则包不访问 CSPRNG、数据库或环境变量。 */
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
