/**
 * I26B 成就纯规则。所有可结算语义（成就是否达成、奖励是否发放）均在此以纯函数实现：
 * 显式版本、显式输入、可重放、不依赖数据库、HTTP、时间或随机源。
 * 解锁/发奖/审计仍由 API 的 application 在同一 SQLite 短事务内原子完成。
 */
export const ACHIEVEMENT_RULE_VERSION = "achievement/v1" as const;

export type AchievementKind = "tournament" | "deck" | "collection";
/** 徽章为不可交易展示物，不进入库存或市场；GAME_CREDIT 与 sku 走账本/库存原子入账。 */
export type AchievementRewardKind = "GAME_CREDIT" | "sku" | "badge";

export interface AchievementRewardSpec {
  kind: AchievementRewardKind;
  amount: number;
  packId: string | null;
  skuId: string | null;
  badgeId: string | null;
}

export interface AchievementDisplay {
  title: string;
  description: string;
  badge: string | null;
}

export interface AchievementDefinition {
  id: string;
  kind: AchievementKind;
  category: string;
  ruleVersion: string;
  /** 0 或正整数目标值；首次/冠军类可为 1，里程碑类为阈值。 */
  goal: number;
  reward: AchievementRewardSpec;
  display: AchievementDisplay;
  hidden: boolean;
}

/** 赛事类成就的玩家档案：参与、胜场与截至该事件的连续胜场数。 */
export interface TournamentAchievementProfile {
  participated: boolean;
  totalWins: number;
  /** 截至当前事件的连续结算胜场（上一败后重新计数）。 */
  consecutiveWins: number;
}

/** 卡组类成就的玩家档案：本次报名的指挥官颜色与主导系列代码。 */
export interface DeckAchievementProfile {
  commanderColors: string[];
  /** 主导系列代码（占非地牌最多的系列）；无主导时为 null。 */
  dominantSetCode: string | null;
}

/** I33B：系列收集率成就的玩家档案：按系列聚合的收集/总数完成度（bp）。 */
export interface SetCompletionProfile {
  /** 该系列已持有（quantity > 0）的不同 SKU 数。 */
  collectedSkuCount: number;
  /** 该系列全部印刷×工艺 SKU 数（目录全量，供完成度计算）。 */
  totalSkuCount: number;
}

/** 单条成就的评估结论。 */
export interface AchievementEvaluation {
  definitionId: string;
  unlocked: boolean;
  /** 达成后的进度值（未达成时为当前值）。 */
  progress: number;
  goal: number;
}

export interface AchievementEvaluationResult {
  ruleVersion: string;
  evaluations: AchievementEvaluation[];
}

/** 奖励风控结论；allowed=false 时不发奖，由 application 记录审计并跳过奖励。 */
export interface AchievementRewardRiskResult {
  ruleVersion: string;
  allowed: boolean;
  reasons: string[];
}

function nonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} 必须为非负安全整数`);
}

function nonEmptyTrimmed(value: string, label: string): void {
  if (value.trim().length === 0) throw new RangeError(`${label} 不能为空`);
}

function validateReward(reward: AchievementRewardSpec, definitionId: string): void {
  nonNegativeSafeInteger(reward.amount, `成就 ${definitionId} 奖励金额`);
  const exclusive: AchievementRewardKind[] = ["GAME_CREDIT", "sku", "badge"];
  if (!exclusive.includes(reward.kind)) throw new RangeError(`成就 ${definitionId} 奖励类型不合法`);
  if (reward.kind === "GAME_CREDIT" && reward.amount <= 0) throw new RangeError(`成就 ${definitionId} 货币奖励必须为正`);
  if (reward.kind === "GAME_CREDIT" && (reward.skuId !== null || reward.packId !== null || reward.badgeId !== null)) throw new RangeError(`成就 ${definitionId} 货币奖励不得携带 SKU/补充包/徽章`);
  if (reward.kind === "sku" && reward.skuId === null) throw new RangeError(`成就 ${definitionId} SKU 奖励缺少 skuId`);
  if (reward.kind === "sku" && (reward.amount !== 0 || reward.packId !== null || reward.badgeId !== null)) throw new RangeError(`成就 ${definitionId} SKU 奖励不得携带货币/补充包/徽章`);
  if (reward.kind === "badge" && reward.badgeId === null) throw new RangeError(`成就 ${definitionId} 徽章奖励缺少 badgeId`);
  if (reward.kind === "badge" && (reward.amount !== 0 || reward.packId !== null || reward.skuId !== null)) throw new RangeError(`成就 ${definitionId} 徽章奖励不得携带货币/补充包/SKU`);
}

function validateDefinition(definition: AchievementDefinition): void {
  nonEmptyTrimmed(definition.id, "成就 ID");
  nonEmptyTrimmed(definition.category, `成就 ${definition.id} 分类`);
  nonNegativeSafeInteger(definition.goal, `成就 ${definition.id} 目标`);
  nonEmptyTrimmed(definition.display.title, `成就 ${definition.id} 标题`);
  nonEmptyTrimmed(definition.display.description, `成就 ${definition.id} 描述`);
  if (typeof definition.hidden !== "boolean") throw new RangeError(`成就 ${definition.id} hidden 必须是布尔值`);
  validateReward(definition.reward, definition.id);
}

/**
 * 受控首批成就。ID 由迁移固定，与 `0028_achievements.sql` 一一对应；
 * 调用方负责把 reward 携带的 skuId 解析为当前目录中的真实 SKU。
 * 纯函数、版本化：相同输入恒产生相同定义集，便于审计与前端一致性校验。
 */
export function resolveFirstAchievements(version: string): AchievementDefinition[] {
  if (version !== ACHIEVEMENT_RULE_VERSION) throw new RangeError(`不支持的成就规则版本：${version}`);
  const definitions: AchievementDefinition[] = [
    { id: "first-tournament/v1", kind: "tournament", category: "tournament", ruleVersion: version, goal: 1, reward: { kind: "GAME_CREDIT", amount: 200, packId: null, skuId: null, badgeId: null }, display: { title: "初登赛场", description: "完成你的第一场赛事结算", badge: "first-tournament" }, hidden: false },
    { id: "tournament-champion/v1", kind: "tournament", category: "tournament", ruleVersion: version, goal: 1, reward: { kind: "badge", amount: 0, packId: null, skuId: null, badgeId: "tournament-champion" }, display: { title: "冠军时刻", description: "在一场赛事中夺冠（排名第一）", badge: "tournament-champion" }, hidden: false },
    { id: "win-streak-3/v1", kind: "tournament", category: "tournament", ruleVersion: version, goal: 3, reward: { kind: "GAME_CREDIT", amount: 500, packId: null, skuId: null, badgeId: null }, display: { title: "三连胜", description: "连续 3 场赛事结算均夺冠", badge: "win-streak-3" }, hidden: false },
    { id: "mono-color-commander/v1", kind: "deck", category: "deck", ruleVersion: version, goal: 1, reward: { kind: "badge", amount: 0, packId: null, skuId: null, badgeId: "mono-color-commander" }, display: { title: "纯粹色系", description: "使用单色指挥官参赛并夺冠", badge: "mono-color-commander" }, hidden: false },
    { id: "series-pilot/v1", kind: "deck", category: "deck", ruleVersion: version, goal: 1, reward: { kind: "badge", amount: 0, packId: null, skuId: null, badgeId: "series-pilot" }, display: { title: "系列先锋", description: "使用同一系列占主导的卡组参赛并夺冠", badge: "series-pilot" }, hidden: true },
    { id: "collection-10/v1", kind: "collection", category: "collection", ruleVersion: version, goal: 10, reward: { kind: "GAME_CREDIT", amount: 100, packId: null, skuId: null, badgeId: null }, display: { title: "收藏起步", description: "持有 10 种不同卡牌 SKU", badge: "collection-10" }, hidden: false },
    { id: "collection-50/v1", kind: "collection", category: "collection", ruleVersion: version, goal: 50, reward: { kind: "GAME_CREDIT", amount: 500, packId: null, skuId: null, badgeId: null }, display: { title: "收藏进阶", description: "持有 50 种不同卡牌 SKU", badge: "collection-50" }, hidden: false },
    { id: "collection-100/v1", kind: "collection", category: "collection", ruleVersion: version, goal: 100, reward: { kind: "GAME_CREDIT", amount: 1_000, packId: null, skuId: null, badgeId: null }, display: { title: "收藏家", description: "持有 100 种不同卡牌 SKU", badge: "collection-100" }, hidden: false },
    // I33B：系列收集率里程碑。goal 为完成度 bp 阈值（80% = 8000、100% = 10000），
    // 与 0035_set_completion_achievements.sql 的 definition_id 一一对应。
    { id: "set-completion-80/v1", kind: "collection", category: "collection-set", ruleVersion: version, goal: 8000, reward: { kind: "GAME_CREDIT", amount: 300, packId: null, skuId: null, badgeId: null }, display: { title: "系列图鉴·八成", description: "任意一个系列的收集率达到 80%", badge: "set-completion-80" }, hidden: false },
    { id: "set-completion-100/v1", kind: "collection", category: "collection-set", ruleVersion: version, goal: 10000, reward: { kind: "badge", amount: 0, packId: null, skuId: null, badgeId: "set-completion-100" }, display: { title: "系列图鉴·圆满", description: "任意一个系列的收集率达到 100%", badge: "set-completion-100" }, hidden: false }
  ];
  for (const definition of definitions) {
    validateDefinition(definition);
    if (definition.ruleVersion !== version) throw new RangeError(`成就 ${definition.id} 规则版本与请求版本不一致`);
  }
  return definitions;
}

function resolveDefinitions(version: string, definitionIds: string[]): Map<string, AchievementDefinition> {
  const all = new Map(resolveFirstAchievements(version).map((definition) => [definition.id, definition]));
  const selected = new Map<string, AchievementDefinition>();
  for (const id of definitionIds) {
    const definition = all.get(id);
    if (!definition) throw new RangeError(`未知的成就定义：${id}`);
    selected.set(id, definition);
  }
  return selected;
}

/**
 * 赛事类成就评估。首次参赛看 `participated`，冠军看 `totalWins >= 1`，
 * 三连胜看 `consecutiveWins >= goal`。纯函数：相同输入恒产生相同结论。
 */
export function evaluateTournamentAchievements(input: {
  ruleVersion: string;
  definitionIds: string[];
  profile: TournamentAchievementProfile;
}): AchievementEvaluationResult {
  if (input.ruleVersion !== ACHIEVEMENT_RULE_VERSION) throw new RangeError(`不支持的成就规则版本：${input.ruleVersion}`);
  if (typeof input.profile.participated !== "boolean") throw new RangeError("参赛标记必须是布尔值");
  nonNegativeSafeInteger(input.profile.totalWins, "总胜场");
  nonNegativeSafeInteger(input.profile.consecutiveWins, "连续胜场");
  const selected = resolveDefinitions(input.ruleVersion, input.definitionIds);
  const evaluations: AchievementEvaluation[] = [];
  for (const [id, definition] of selected) {
    if (definition.kind !== "tournament") {
      evaluations.push({ definitionId: id, unlocked: false, progress: 0, goal: definition.goal });
      continue;
    }
    let progress = 0;
    if (id === "first-tournament/v1") progress = input.profile.participated ? 1 : 0;
    else if (id === "tournament-champion/v1") progress = input.profile.totalWins >= 1 ? 1 : 0;
    else if (id === "win-streak-3/v1") progress = Math.min(definition.goal, input.profile.consecutiveWins);
    else progress = 0;
    evaluations.push({ definitionId: id, unlocked: progress >= definition.goal, progress, goal: definition.goal });
  }
  return { ruleVersion: input.ruleVersion, evaluations: evaluations.sort((left, right) => left.definitionId.localeCompare(right.definitionId)) };
}

/**
 * 卡组类成就评估。单色指挥官看颜色数 === 1 且已夺冠（`won` 由调用方在 profile 命名中体现）；
 * 系列先锋看存在主导系列且已夺冠。这里只判断颜色/系列结构，是否夺冠由调用方决定是否调用。
 */
export function evaluateDeckAchievements(input: {
  ruleVersion: string;
  definitionIds: string[];
  profile: DeckAchievementProfile;
  /** 本场结算是否夺冠；卡组类成就均要求夺冠才解锁。 */
  won: boolean;
}): AchievementEvaluationResult {
  if (input.ruleVersion !== ACHIEVEMENT_RULE_VERSION) throw new RangeError(`不支持的成就规则版本：${input.ruleVersion}`);
  if (!Array.isArray(input.profile.commanderColors)) throw new RangeError("指挥官颜色必须是数组");
  const colors = [...new Set(input.profile.commanderColors)].filter((color): color is string => typeof color === "string" && color.length > 0);
  if (colors.some((color) => !["W", "U", "B", "R", "G"].includes(color))) throw new RangeError("指挥官颜色必须是 W/U/B/R/G");
  if (typeof input.won !== "boolean") throw new RangeError("夺冠标记必须是布尔值");
  const selected = resolveDefinitions(input.ruleVersion, input.definitionIds);
  const evaluations: AchievementEvaluation[] = [];
  for (const [id, definition] of selected) {
    if (definition.kind !== "deck") {
      evaluations.push({ definitionId: id, unlocked: false, progress: 0, goal: definition.goal });
      continue;
    }
    let progress = 0;
    if (id === "mono-color-commander/v1") progress = colors.length === 1 && input.won ? 1 : 0;
    else if (id === "series-pilot/v1") progress = input.profile.dominantSetCode !== null && input.won ? 1 : 0;
    else progress = 0;
    evaluations.push({ definitionId: id, unlocked: progress >= definition.goal, progress, goal: definition.goal });
  }
  return { ruleVersion: input.ruleVersion, evaluations: evaluations.sort((left, right) => left.definitionId.localeCompare(right.definitionId)) };
}

/**
 * 收藏里程碑评估。只比较 `distinctSkuCount` 与各成就 goal；进度按阈值封顶。
 * 调用方在每次赛事结算后重算 distinctSkuCount，使持有变化能即时反映。
 */
export function evaluateCollectionAchievements(input: {
  ruleVersion: string;
  definitionIds: string[];
  distinctSkuCount: number;
}): AchievementEvaluationResult {
  if (input.ruleVersion !== ACHIEVEMENT_RULE_VERSION) throw new RangeError(`不支持的成就规则版本：${input.ruleVersion}`);
  nonNegativeSafeInteger(input.distinctSkuCount, "不同 SKU 数");
  const selected = resolveDefinitions(input.ruleVersion, input.definitionIds);
  const evaluations: AchievementEvaluation[] = [];
  for (const [id, definition] of selected) {
    if (definition.kind !== "collection") {
      evaluations.push({ definitionId: id, unlocked: false, progress: 0, goal: definition.goal });
      continue;
    }
    const progress = Math.min(definition.goal, input.distinctSkuCount);
    evaluations.push({ definitionId: id, unlocked: progress >= definition.goal, progress, goal: definition.goal });
  }
  return { ruleVersion: input.ruleVersion, evaluations: evaluations.sort((left, right) => left.definitionId.localeCompare(right.definitionId)) };
}

/**
 * I33B：系列收集率里程碑评估。对每个收藏-系列成就，以玩家在该系列的完成度 bp
 * （collectedSkuCount × 10_000 ÷ totalSkuCount，按目标封顶）为进度；任一系列达到
 * 80%/100% 即解锁。totalSkuCount 为 0 时完成度计 0，绝不除以零；纯函数可重放。
 */
export function evaluateSetCompletionAchievements(input: {
  ruleVersion: string;
  definitionIds: string[];
  /** 系列收集率成就定义的 goal 以 bp 表达（8000/10000）。 */
  profile: SetCompletionProfile;
}): AchievementEvaluationResult {
  if (input.ruleVersion !== ACHIEVEMENT_RULE_VERSION) throw new RangeError(`不支持的成就规则版本：${input.ruleVersion}`);
  nonNegativeSafeInteger(input.profile.collectedSkuCount, "系列已收集 SKU 数");
  nonNegativeSafeInteger(input.profile.totalSkuCount, "系列总 SKU 数");
  if (input.profile.collectedSkuCount > input.profile.totalSkuCount) throw new RangeError("系列已收集 SKU 数不能超过总数");
  const completionBp = input.profile.totalSkuCount === 0
    ? 0
    : Math.min(10_000, Math.floor((input.profile.collectedSkuCount * 10_000) / input.profile.totalSkuCount));
  const selected = resolveDefinitions(input.ruleVersion, input.definitionIds);
  const evaluations: AchievementEvaluation[] = [];
  for (const [id, definition] of selected) {
    if (definition.kind !== "collection" || definition.category !== "collection-set") {
      evaluations.push({ definitionId: id, unlocked: false, progress: 0, goal: definition.goal });
      continue;
    }
    const progress = Math.min(definition.goal, completionBp);
    evaluations.push({ definitionId: id, unlocked: progress >= definition.goal, progress, goal: definition.goal });
  }
  return { ruleVersion: input.ruleVersion, evaluations: evaluations.sort((left, right) => left.definitionId.localeCompare(right.definitionId)) };
}

/**
 * 奖励风控纯规则。每日奖励发放次数与重复参赛次数超限时拒绝发奖（仍允许解锁记录本身）。
 * `rewardsToday`/`repeatParticipationToday` 由 application 在风控计数表中维护。
 */
export function evaluateRewardRisk(input: {
  ruleVersion: string;
  rewardsToday: number;
  maxRewardsPerDay: number;
  repeatParticipationToday: number;
  maxRepeatPerDay: number;
}): AchievementRewardRiskResult {
  if (input.ruleVersion !== ACHIEVEMENT_RULE_VERSION) throw new RangeError(`不支持的成就规则版本：${input.ruleVersion}`);
  nonNegativeSafeInteger(input.rewardsToday, "今日已发奖励数");
  nonNegativeSafeInteger(input.maxRewardsPerDay, "每日奖励上限");
  nonNegativeSafeInteger(input.repeatParticipationToday, "今日重复参赛数");
  nonNegativeSafeInteger(input.maxRepeatPerDay, "重复参赛上限");
  if (input.maxRewardsPerDay === 0) throw new RangeError("每日奖励上限必须大于 0");
  if (input.maxRepeatPerDay === 0) throw new RangeError("重复参赛上限必须大于 0");
  const reasons: string[] = [];
  if (input.rewardsToday >= input.maxRewardsPerDay) reasons.push("daily_reward_limit");
  if (input.repeatParticipationToday >= input.maxRepeatPerDay) reasons.push("repeat_participation_limit");
  return { ruleVersion: input.ruleVersion, allowed: reasons.length === 0, reasons };
}
