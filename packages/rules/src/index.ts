export interface NpcQuoteInput {
  referencePrice: number;
  marketFactor: number;
  buySpread: number;
  sellSpread: number;
}

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

export function calculateNpcQuote(input: NpcQuoteInput) {
  const mid = roundCurrency(input.referencePrice * input.marketFactor);

  return {
    referencePrice: input.referencePrice,
    marketPrice: mid,
    npcBuyPrice: roundCurrency(mid * (1 - input.buySpread)),
    npcSellPrice: roundCurrency(mid * (1 + input.sellSpread))
  };
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
