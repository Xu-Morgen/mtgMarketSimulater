/**
 * I35B 每日/每周任务纯规则。任务定义、目标与进度判定均在此以纯函数实现：
 * 显式版本、显式输入、可重放、不依赖数据库、HTTP、时间或随机源。
 * 实例持久化与奖励发放仍由 API 的 application 在同一 SQLite 短事务内原子完成。
 */
export const DAILY_TASK_RULE_VERSION = "daily-task/v1" as const;

export type TaskPeriodKind = "daily" | "weekly";
/** 进度推进只由已结算事实触发；collection.value 与 set.completion 为状态型（取样本峰值/最高完成度）。 */
export type TaskMetricType = "pack.open" | "trade" | "npc.sell" | "collection.value" | "tournament.play" | "set.completion";

export interface DailyTaskDefinition {
  id: string;
  period: TaskPeriodKind;
  metricType: TaskMetricType;
  /** 目标值：数量/场次/金额（最小货币单位）或完成度 bp（0–10000）。 */
  targetAmount: number;
  rewardAmount: number;
  title: string;
  description: string;
}

export interface TaskAdvanceProfile {
  /** pack.open / tournament.settled 事实计 1；trade/npc.sell 按成交张数计；collection.value 为净资产样本；set.completion 为系列最高完成度 bp。 */
  contribution: number;
  /** 状态型指标（collection.value / set.completion）为 true：以 max(现有, 样本) 推进而非累加。 */
  state: boolean;
}

export function resolveDailyTaskDefinitions(version: string): DailyTaskDefinition[] {
  if (version !== DAILY_TASK_RULE_VERSION) throw new RangeError(`不支持的每日任务规则版本：${version}`);
  return [
    { id: "daily-open-3/v1", period: "daily", metricType: "pack.open", targetAmount: 3, rewardAmount: 100, title: "每日开包", description: "本日开包 3 次" },
    { id: "daily-trade-10/v1", period: "daily", metricType: "trade", targetAmount: 10, rewardAmount: 100, title: "每日交易", description: "本日完成 10 张卡牌交易（NPC 或玩家间）" },
    { id: "daily-sell-1/v1", period: "daily", metricType: "npc.sell", targetAmount: 1, rewardAmount: 80, title: "每日卖出", description: "本日向 NPC 卖出至少一张卡牌" },
    { id: "daily-collection-2000/v1", period: "daily", metricType: "collection.value", targetAmount: 2000, rewardAmount: 120, title: "收藏价值目标", description: "本日持仓价值达到 2000 游戏币" },
    { id: "weekly-tournament-3/v1", period: "weekly", metricType: "tournament.play", targetAmount: 3, rewardAmount: 300, title: "每周参赛", description: "本周完成 3 场赛事结算" },
    { id: "weekly-set-80/v1", period: "weekly", metricType: "set.completion", targetAmount: 8000, rewardAmount: 500, title: "每周收集", description: "本周任一系列收集完成度达到 80%" }
  ];
}

/**
 * 计算一次事实对任务实例的推进结果。计数型指标（pack.open/npc.trade/tournament.play）
 * 累加贡献值；状态型指标（collection.value/set.completion）以 max(现有, 样本) 收敛，
 * 保证样本峰值与最高完成度只升不降，卖出/消费后任务进度不回退。
 * 非法输入抛 RangeError，绝不静默回退。
 */
export function applyTaskAdvance(input: {
  ruleVersion: string;
  definition: DailyTaskDefinition;
  previousValue: number;
  profile: TaskAdvanceProfile;
}): { newValue: number; achieved: boolean } {
  if (input.ruleVersion !== DAILY_TASK_RULE_VERSION) throw new RangeError(`不支持的每日任务规则版本：${input.ruleVersion}`);
  const contribution = input.profile.contribution;
  const previous = input.previousValue;
  if (!Number.isSafeInteger(contribution) || contribution < 0) throw new RangeError("任务推进值必须是非负安全整数");
  if (!Number.isSafeInteger(previous) || previous < 0) throw new RangeError("任务既有进度必须是非负安全整数");
  const newValue = input.profile.state ? Math.max(previous, contribution) : previous + contribution;
  return { newValue, achieved: newValue >= input.definition.targetAmount };
}
