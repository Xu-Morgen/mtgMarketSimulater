/**
 * I36B/I36F 新手引导纯规则。引导步骤定义、完成判定与一次性完成奖励均在此以纯函数实现：
 * 显式版本、显式输入、可重放、不依赖数据库、HTTP、时间或随机源。
 * 进度持久化、跳过标记与奖励发放仍由 API 的 application 在短事务内原子完成。
 *
 * 步骤按「首次目标链」排序：创建存档 → 领取工作资金 → 开包 → 看懂价格 →
 * 首笔 NPC 交易 → 收藏见涨 → 首次报名。完成判定分为三类：
 * - `fact`：由已结算事实（pack.opened/npc.trade.settled）的同事务幂等消费者推进，
 *   计数型（goal 为累计目标），重放同一事实不重复计数；
 * - `profile`：由服务端对已结算状态（存档/账本/库存/报名表）快照判定，满足即完成、只升不降；
 * - `view_event`：仅价格历史页要求玩家实际浏览，由浏览器提交意图、服务端记录访问事件
 *   后完成，浏览器不得自行判定。
 */
export const ONBOARDING_RULE_VERSION = "onboarding/v2" as const;

export type OnboardingStepSource = "fact" | "profile" | "view_event";

export interface OnboardingStepDefinition {
  /** 稳定步骤 ID；作为 onboarding_progress/onboarding_events 的引用键，不随版本切换漂移。 */
  id: string;
  title: string;
  description: string;
  /** 前端目标功能入口（App Router 路径），供引导卡片跳转。 */
  href: string;
  /** view_event 步骤的服务端访问路径；服务端据此校验访问事件与步骤匹配，其余步骤为 null。 */
  targetPath: string | null;
  /** 玩家可跳过；跳过永久视为已完成（老玩家补完目标链与领取奖励的路径）。 */
  skippable: boolean;
  source: OnboardingStepSource;
  /** fact 步骤消费的已结算事实事件类型。 */
  factEventType?: string;
  /** profile 步骤的服务端状态快照键。 */
  profileKey?: string;
  /** fact 步骤的累计完成目标（首次目标链均为 1）。 */
  goal?: number;
}

export function resolveOnboardingSteps(version: string): OnboardingStepDefinition[] {
  if (version !== ONBOARDING_RULE_VERSION) throw new RangeError(`不支持的新手引导规则版本：${version}`);
  return [
    {
      id: "create-archive",
      title: "创建存档",
      description: "点击玩家首页「创建游戏存档」按钮，服务器会初始化你的账户和初始资金",
      href: "/dashboard",
      targetPath: null,
      skippable: true,
      source: "profile",
      profileKey: "archive_created"
    },
    {
      id: "claim-work-funds",
      title: "领取工作资金",
      description: "在玩家首页领取今日工作资金，开始你的卡牌交易所之旅",
      href: "/dashboard",
      targetPath: null,
      skippable: true,
      source: "profile",
      profileKey: "work_funds_claimed"
    },
    {
      id: "open-first-pack",
      title: "开出第一包",
      description: "在补充包商店购买并开出第一包补充包",
      href: "/packs",
      targetPath: null,
      skippable: true,
      source: "fact",
      factEventType: "pack.opened",
      goal: 1
    },
    {
      id: "view-price-history",
      title: "看懂价格",
      description: "打开单卡价格历史，查看参考价与游戏内报价的双价格走势",
      href: "/market/history",
      targetPath: "/market/history",
      skippable: true,
      source: "view_event"
    },
    {
      id: "complete-first-npc-trade",
      title: "完成首笔交易",
      description: "在市场向 NPC 完成你的第一笔卡牌交易",
      href: "/market",
      targetPath: null,
      skippable: true,
      source: "fact",
      factEventType: "npc.trade.settled",
      goal: 1
    },
    {
      id: "unlock-collection-album",
      title: "收藏见涨",
      description: "打开收藏图鉴，查看已收集卡牌与系列完成度",
      href: "/collection/album",
      targetPath: null,
      skippable: true,
      source: "profile",
      profileKey: "collection_has_any"
    },
    {
      id: "first-tournament-registration",
      title: "首次报名",
      description: "构筑合法卡组并报名一场比赛",
      href: "/tournaments",
      targetPath: null,
      skippable: true,
      source: "profile",
      profileKey: "tournament_registered"
    }
  ];
}

/** 一次性完成奖励：全部步骤完成后由服务端发放一次（经账本不可变流水，唯一约束防重发）。 */
export const ONBOARDING_REWARD = { amount: 500, currency: "GAME_CREDIT" as const };

export function resolveOnboardingReward(version: string): typeof ONBOARDING_REWARD {
  if (version !== ONBOARDING_RULE_VERSION) throw new RangeError(`不支持的新手引导规则版本：${version}`);
  return ONBOARDING_REWARD;
}

/** 判定 view_event 步骤的访问事件路径是否与步骤定义匹配；不匹配返回 false，由调用方决定语义。 */
export function isViewEventStepMatch(step: OnboardingStepDefinition, eventPath: string): boolean {
  return step.source === "view_event" && step.targetPath !== null && eventPath === step.targetPath;
}

/**
 * 计算一次已结算事实对 fact 步骤的推进结果。首次目标链步骤均为累计型：
 * newValue = previousValue + contribution，达到 goal 即完成；非法输入抛 RangeError，
 * 绝不静默回退。profile/view_event 步骤不经过本函数（由服务端状态快照直接置完成）。
 */
export function applyOnboardingAdvance(input: {
  ruleVersion: string;
  step: OnboardingStepDefinition;
  previousValue: number;
  contribution: number;
}): { newValue: number; achieved: boolean } {
  if (input.ruleVersion !== ONBOARDING_RULE_VERSION) throw new RangeError(`不支持的新手引导规则版本：${input.ruleVersion}`);
  if (input.step.source !== "fact" || input.step.goal === undefined) throw new RangeError(`步骤 ${input.step.id} 不是可累加推进的事实步骤`);
  const contribution = input.contribution;
  const previous = input.previousValue;
  if (!Number.isSafeInteger(contribution) || contribution < 0) throw new RangeError("引导推进值必须是非负安全整数");
  if (!Number.isSafeInteger(previous) || previous < 0) throw new RangeError("引导既有进度必须是非负安全整数");
  const newValue = previous + contribution;
  return { newValue, achieved: newValue >= input.step.goal };
}
