/**
 * I35B 等级/声望纯规则。经验、等级、称号与解锁能力均在此以纯函数实现：
 * 显式版本、显式输入、可重放、不依赖数据库、HTTP、时间或随机源。
 * 等级持久化、能力生效与升级奖励发放仍由 API 的 application 在同事务内原子完成。
 */
export const LEVEL_RULE_VERSION = "level/v1" as const;
export const MAX_LEVEL = 5 as const;

/** 各等级所需累计经验阈值；index 0 对应等级 1。等级封顶 MAX_LEVEL，溢出经验仍累计。 */
export const LEVEL_XP_THRESHOLDS = [0, 200, 500, 1_000, 2_000] as const;

/** 各等级解锁能力；等级 1 为默认能力，与引入等级系统前的行为完全一致。 */
export const LEVEL_CAPABILITIES: Record<number, { npcDailyTradeMultiplier: number; bulkPackMax: number }> = {
  1: { npcDailyTradeMultiplier: 1, bulkPackMax: 10 },
  2: { npcDailyTradeMultiplier: 1, bulkPackMax: 50 },
  3: { npcDailyTradeMultiplier: 2, bulkPackMax: 100 },
  4: { npcDailyTradeMultiplier: 3, bulkPackMax: 100 },
  5: { npcDailyTradeMultiplier: 5, bulkPackMax: 100 }
};

/** 升级奖励：key 为目标等级（2–5），值为一次性 GAME_CREDIT 奖励。 */
export const LEVEL_UP_REWARDS: Record<number, number> = {
  2: 200,
  3: 300,
  4: 500,
  5: 1_000
};

export const LEVEL_TITLES: Record<number, string> = {
  1: "见习收藏家",
  2: "资深收藏家",
  3: "卡牌行家",
  4: "市场操盘手",
  5: "传奇收藏家"
};

export interface LevelExperienceInput {
  ruleVersion: string;
  /** 历史峰值净资产（最小货币单位）；单调，不随消费回退。 */
  peakNetWorthAmount: number;
  /** 已结算交易张数（NPC 买入/卖出 + 已履约双边成交）。 */
  settledTrades: number;
  /** 完成度达到 80% 的系列数与达到 100% 的系列数；贡献固定经验，不随持仓变化回退。 */
  collectionCompletion: { setsAt80: number; setsAt100: number };
}

export interface LevelExperienceResult {
  totalXp: number;
  level: number;
  title: string;
  /** 下一级所需累计经验；封顶级返回 null。 */
  nextLevelXp: number | null;
  /** 当前级内的进度 bp（0–10000）；封顶级为 10000。 */
  progressBasisPoints: number;
}

/** 经验 = 净资产每千分 20 + 每张已结算交易 5 + 80% 系列每系列 10 + 100% 系列每系列 50；可重放且单调。 */
export function resolveLevelExperience(input: LevelExperienceInput): LevelExperienceResult {
  if (input.ruleVersion !== LEVEL_RULE_VERSION) throw new RangeError(`不支持的等级规则版本：${input.ruleVersion}`);
  if (!Number.isSafeInteger(input.peakNetWorthAmount) || input.peakNetWorthAmount < 0) throw new RangeError("净资产峰值必须是非负安全整数");
  if (!Number.isSafeInteger(input.settledTrades) || input.settledTrades < 0) throw new RangeError("已结算交易数必须是非负安全整数");
  for (const count of [input.collectionCompletion.setsAt80, input.collectionCompletion.setsAt100]) {
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("系列完成度计数必须是非负安全整数");
  }
  const xpFromWorth = Math.floor(input.peakNetWorthAmount / 1_000) * 20;
  const xpFromTrades = input.settledTrades * 5;
  const xpFromSets = input.collectionCompletion.setsAt80 * 10 + input.collectionCompletion.setsAt100 * 50;
  const totalXp = xpFromWorth + xpFromTrades + xpFromSets;
  let level = 1;
  for (let index = 1; index < LEVEL_XP_THRESHOLDS.length; index += 1) {
    if (totalXp < LEVEL_XP_THRESHOLDS[index]!) break;
    level = index + 1;
  }
  if (level > MAX_LEVEL) level = MAX_LEVEL;
  const threshold = LEVEL_XP_THRESHOLDS[level - 1]!;
  const next = LEVEL_XP_THRESHOLDS[level];
  const progressBasisPoints = next === undefined
    ? 10_000
    : Math.min(10_000, Math.floor(((totalXp - threshold) / (next - threshold)) * 10_000));
  return {
    totalXp,
    level,
    title: LEVEL_TITLES[level]!,
    nextLevelXp: next === undefined ? null : next,
    progressBasisPoints
  };
}

export interface LevelCapabilities {
  npcDailyTradeMultiplier: number;
  bulkPackMax: number;
}

export function resolveLevelCapabilities(level: number): LevelCapabilities {
  if (!Number.isSafeInteger(level) || level < 1) throw new RangeError("等级必须是不小于 1 的安全整数");
  const capabilities = LEVEL_CAPABILITIES[Math.min(level, MAX_LEVEL)];
  if (!capabilities) throw new Error(`等级能力表缺少等级 ${level} 的配置`);
  return capabilities;
}

export function resolveLevelUpReward(version: string, targetLevel: number): number | null {
  if (version !== LEVEL_RULE_VERSION) throw new RangeError(`不支持的等级规则版本：${version}`);
  return LEVEL_UP_REWARDS[targetLevel] ?? null;
}
