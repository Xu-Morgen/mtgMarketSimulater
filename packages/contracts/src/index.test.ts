import { describe, expect, it } from "vitest";
import {
  canonicalizeRequest,
  isValidIdempotencyKey,
  isValidMoney,
  isValidRequestFingerprint,
  isValidRequestId,
  type AchievementDefinitionDto,
  type AchievementProgressDto,
  type AchievementUnlockDto,
  type ApiResponse,
  type BilateralFulfillmentType,
  type BilateralOrderBookDto,
  type CollectionAlbumDto,
  type DailyWorkFundingStatusDto,
  type DeckPowerSnapshotDto,
  type DuplicatesSellResultDto,
  type EconomicFactEvent,
  type GrowthProfileDto,
  type MarketAnnouncementDto,
  type MarketHeatDto,
  type PackOfferDto,
  type PackOpeningCardDto,
  type PackOpeningDto,
  type PlayerBilateralTradeDto,
  type TaskCenterDto,
  type TaskClaimDto,
  type TaskInstanceDto,
  type WatchlistAlertsDto,
  type WatchlistItemDto
} from "./index.js";

describe("共享契约", () => {
  it("能稳定序列化等价但键顺序不同的请求", () => {
    expect(canonicalizeRequest({ quantity: 2, skuId: "sku-1" })).toBe(
      canonicalizeRequest({ skuId: "sku-1", quantity: 2 })
    );
  });

  it("拒绝不能安全序列化的请求值", () => {
    expect(() => canonicalizeRequest({ value: Number.NaN })).toThrow("非有限数字");
    expect(() => canonicalizeRequest(undefined)).toThrow("JSON 值");
    expect(() => canonicalizeRequest(new Date())).toThrow("普通 JSON 对象");
  });

  it("校验请求 ID、幂等键、指纹和整数金额", () => {
    expect(isValidRequestId("req_20260724_01")).toBe(true);
    expect(isValidRequestId("short")).toBe(false);
    expect(isValidIdempotencyKey("idem_20260724_01")).toBe(true);
    expect(isValidIdempotencyKey("bad key")).toBe(false);
    expect(isValidRequestFingerprint("a".repeat(64))).toBe(true);
    expect(isValidRequestFingerprint("a".repeat(63))).toBe(false);
    expect(isValidMoney({ amount: 100, currency: "GAME_CREDIT" })).toBe(true);
    expect(isValidMoney({ amount: 0.1, currency: "GAME_CREDIT" })).toBe(false);
    expect(isValidMoney({ amount: -1, currency: "GAME_CREDIT" })).toBe(false);
  });

  it("保留冲突响应和已结算事实事件的可序列化形状", () => {
    const conflict: ApiResponse<never> = {
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT", message: "同一键对应不同请求" },
      meta: { requestId: "req_20260724_01" }
    };
    const event: EconomicFactEvent = {
      id: "event-1",
      type: "pack.opened",
      version: 1,
      occurredAt: "2026-07-24T00:00:00.000Z",
      correlationId: "pack-open-1",
      payload: {
        userId: "user-1",
        packId: "pack-1",
        packRuleVersion: "v1",
        spent: { amount: 500, currency: "GAME_CREDIT" },
        received: [{ skuId: "sku-1", quantity: 1 }]
      }
    };

    expect(JSON.parse(JSON.stringify(conflict))).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" }
    });
    expect(JSON.parse(JSON.stringify(event))).toMatchObject({ type: "pack.opened", version: 1 });
  });

  it("I19F 玩家视角成交 DTO 脱敏对手身份并保留待履约资产字段", () => {
    const buyerView: PlayerBilateralTradeDto = {
      id: "trade-1",
      skuId: "sku-1",
      role: "buyer",
      myOrderId: "my-buy-order",
      quantity: 2,
      executionPrice: { amount: 200, currency: "GAME_CREDIT" },
      fee: { amount: 8, currency: "GAME_CREDIT" },
      pendingFunds: { amount: 408, currency: "GAME_CREDIT" },
      pendingInventoryQuantity: null,
      ruleVersion: "order-matching/v1",
      status: "matched_pending_fulfillment",
      fulfillmentDeadline: "2026-07-29T00:00:00.000Z",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z"
    };
    const sellerView: PlayerBilateralTradeDto = {
      ...buyerView,
      role: "seller",
      myOrderId: "my-sell-order",
      fee: { amount: 8, currency: "GAME_CREDIT" },
      pendingFunds: { amount: 40, currency: "GAME_CREDIT" },
      pendingInventoryQuantity: 2
    };
    const serializedBuyer = JSON.parse(JSON.stringify(buyerView)) as Record<string, unknown>;
    const serializedSeller = JSON.parse(JSON.stringify(sellerView)) as Record<string, unknown>;
    // 不含对手身份或内部 hold 字段。
    expect(serializedBuyer).not.toHaveProperty("buyerUserId");
    expect(serializedBuyer).not.toHaveProperty("sellerUserId");
    expect(serializedBuyer).not.toHaveProperty("buyOrderId");
    expect(serializedBuyer).not.toHaveProperty("sellOrderId");
    expect(serializedBuyer).not.toHaveProperty("buyerFundsHoldId");
    expect(serializedBuyer).not.toHaveProperty("sellerInventoryHoldId");
    expect(serializedBuyer).not.toHaveProperty("sellerDepositHoldId");
    expect(serializedBuyer).toMatchObject({
      role: "buyer",
      myOrderId: "my-buy-order",
      pendingInventoryQuantity: null
    });
    expect(serializedSeller).toMatchObject({ role: "seller", pendingInventoryQuantity: 2 });
  });

  it("I20B 成交 DTO 在履约/取消/待履约三态下均携带待履约期限", () => {
    for (const status of ["matched_pending_fulfillment", "fulfilled", "cancelled"] as const) {
      const view: PlayerBilateralTradeDto = {
        id: "trade-2",
        skuId: "sku-2",
        role: "buyer",
        myOrderId: "order-2",
        quantity: 1,
        executionPrice: { amount: 200, currency: "GAME_CREDIT" },
        fee: { amount: 4, currency: "GAME_CREDIT" },
        pendingFunds: { amount: 204, currency: "GAME_CREDIT" },
        pendingInventoryQuantity: null,
        ruleVersion: "order-matching/v1",
        status,
        fulfillmentDeadline: "2026-07-29T00:00:00.000Z",
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z"
      };
      const serialized = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
      expect(serialized).toMatchObject({ status, fulfillmentDeadline: "2026-07-29T00:00:00.000Z" });
    }
  });

  it("I20F 模拟履约类型固定为 simulated，不引入实体物流状态", () => {
    // BilateralFulfillmentType 是常量联合；本期唯一取值 "simulated" 表示成交后的确认/取消是经济结算，
    // 客户端只能展示服务端返回的类型，不可自行推导或扩展为实体物流状态。
    const fulfillmentType: BilateralFulfillmentType = "simulated";
    expect(fulfillmentType).toBe("simulated");
  });

  it("I24R 强度快照明确来源、版本、输入摘要、可用性与降级原因", () => {
    const primary: DeckPowerSnapshotDto = {
      source: "leyline",
      sourceVersion: "leyline-adapter/v1",
      providerAlgorithmVersion: "undeclared",
      score: 58,
      inputSummarySha256: "a".repeat(64),
      computedAt: "2026-07-29T00:00:00.000Z",
      availability: "available",
      degradationReason: null,
      responseSha256: "b".repeat(64)
    };
    const degraded: DeckPowerSnapshotDto = {
      ...primary,
      source: "local",
      sourceVersion: "local-deck-power/v1",
      providerAlgorithmVersion: null,
      availability: "degraded",
      degradationReason: "provider_timeout",
      responseSha256: null
    };
    expect(JSON.parse(JSON.stringify(primary))).toMatchObject({
      source: "leyline",
      providerAlgorithmVersion: "undeclared",
      availability: "available"
    });
    expect(JSON.parse(JSON.stringify(degraded))).toMatchObject({
      source: "local",
      degradationReason: "provider_timeout",
      responseSha256: null
    });
    const machineLearning: DeckPowerSnapshotDto = {
      ...primary,
      source: "ml",
      sourceVersion: "deck-power-ml/v1.0.0",
      providerAlgorithmVersion: null,
      responseSha256: null
    };
    expect(JSON.parse(JSON.stringify(machineLearning))).toMatchObject({
      source: "ml",
      sourceVersion: "deck-power-ml/v1.0.0"
    });
  });

  it("I23B 每日工作资金状态只承载服务端快照的日期、时区、规则和金额", () => {
    const status: DailyWorkFundingStatusDto = {
      naturalDate: "2026-07-29",
      timezone: "Asia/Shanghai",
      status: "available",
      amount: { amount: 1000, currency: "GAME_CREDIT" },
      ruleVersion: "daily-work-funds/v1",
      openedAt: "2026-07-28T16:00:00.000Z",
      nextEligibleAt: "2026-07-29T16:00:00.000Z",
      claim: null
    };
    expect(JSON.parse(JSON.stringify(status))).toMatchObject({
      status: "available",
      amount: { amount: 1000 }
    });
  });

  it("I26B 成就定义、进度与解锁来源只承载服务端已结算结果", () => {
    const definition: AchievementDefinitionDto = {
      id: "first-tournament/v1",
      kind: "tournament",
      category: "tournament",
      goal: 1,
      reward: { kind: "GAME_CREDIT", amount: 200, packId: null, skuId: null, badgeId: null },
      display: { title: "初登赛场", description: "完成你的第一场赛事结算", badge: null },
      hidden: false,
      ruleVersion: "achievement/v1"
    };
    const progress: AchievementProgressDto = {
      definitionId: "first-tournament/v1",
      currentValue: 1,
      goalValue: 1,
      status: "unlocked",
      unlockedAt: "2026-07-30T00:00:00.000Z",
      lastEvaluatedFactId: "fact-0001"
    };
    const unlock: AchievementUnlockDto = {
      definitionId: "first-tournament/v1",
      source: { type: "tournament.settled", factId: "fact-0001", aggregateId: "registration-0001" },
      ruleVersion: "achievement/v1",
      unlockedAt: "2026-07-30T00:00:00.000Z",
      reward: { kind: "GAME_CREDIT", amount: 200, packId: null, skuId: null, badgeId: null },
      rewardStatus: "granted",
      rewardCorrelationId: "achievement-reward:unlock-0001"
    };
    const parsed = JSON.parse(JSON.stringify({ definition, progress, unlock }));
    expect(parsed.definition.reward).toMatchObject({ kind: "GAME_CREDIT", amount: 200 });
    expect(parsed.progress).toMatchObject({ status: "unlocked", currentValue: 1 });
    expect(parsed.unlock.source).toMatchObject({ type: "tournament.settled", aggregateId: "registration-0001" });
    expect(parsed.unlock).toMatchObject({ rewardStatus: "granted" });
  });

  it("I33B 开包 DTO 携带新卡标记、系列完成度快照与总成本/总价值", () => {
    const card: PackOpeningCardDto = {
      skuId: "sku-0001",
      quantity: 2,
      cost: { amount: 250, currency: "GAME_CREDIT" },
      referencePrice: { amount: 120, currency: "EUR" },
      gamePrice: { amount: 300, currency: "GAME_CREDIT" },
      priceStatus: "available",
      isNewToCollection: true,
      collectionProgressAfter: { setCode: "PKT", collectedSkuCount: 5, totalSkuCount: 10, completionBasisPoints: 5000 }
    };
    const opening: PackOpeningDto = {
      id: "opening-0001",
      packId: "pack-0001",
      packRuleVersion: "pack/v1",
      spent: { amount: 500, currency: "GAME_CREDIT" },
      received: [card],
      profitLoss: {
        spent: { amount: 500, currency: "GAME_CREDIT" },
        referenceValue: { amount: 240, currency: "EUR" },
        gameValue: { amount: 600, currency: "GAME_CREDIT" },
        referenceProfitLoss: null,
        gameProfitLoss: { amount: 100, currency: "GAME_CREDIT" },
        priceStatus: "available"
      },
      totalCost: { amount: 500, currency: "GAME_CREDIT" },
      totalGameValue: { amount: 600, currency: "GAME_CREDIT" },
      openedAt: "2026-08-04T00:00:00.000Z"
    };
    const parsed = JSON.parse(JSON.stringify({ card, opening })) as { card: PackOpeningCardDto; opening: PackOpeningDto };
    expect(parsed.card).toMatchObject({ isNewToCollection: true });
    expect(parsed.card.collectionProgressAfter).toMatchObject({ setCode: "PKT", completionBasisPoints: 5000 });
    expect(parsed.opening.totalCost).toMatchObject({ amount: 500, currency: "GAME_CREDIT" });
    expect(parsed.opening.totalGameValue).toMatchObject({ amount: 600, currency: "GAME_CREDIT" });
  });

  it("I33B 图鉴/批量卖出/特殊包 offer DTO 只承载服务端只读聚合", () => {
    const album: CollectionAlbumDto = {
      sets: {
        items: [
          {
            setCode: "PKT",
            setName: "补充包测试系列",
            collectedSkuCount: 3,
            totalSkuCount: 10,
            completionBasisPoints: 3000,
            uncollectedCards: [{ name: "未收集卡", setCode: "PKT", collectorNumber: "7", rarity: "common" }]
          }
        ],
        page: { hasMore: false, nextCursor: null }
      }
    };
    const sell: DuplicatesSellResultDto = {
      soldItems: [{ skuId: "sku-1", quantity: 2, unitPrice: { amount: 100, currency: "GAME_CREDIT" }, unitFee: { amount: 5, currency: "GAME_CREDIT" }, total: { amount: 200, currency: "GAME_CREDIT" }, fee: { amount: 10, currency: "GAME_CREDIT" } }],
      skippedItems: [{ skuId: "sku-2", reason: "quote_unavailable" }],
      cardCount: 2,
      income: { amount: 200, currency: "GAME_CREDIT" },
      fee: { amount: 10, currency: "GAME_CREDIT" }
    };
    const offer: PackOfferDto = {
      id: "offer-0001",
      packId: "pack-0001",
      name: "限时折扣",
      description: null,
      discountBps: 8000,
      startsAt: "2026-08-04T00:00:00.000Z",
      endsAt: "2026-08-11T00:00:00.000Z",
      status: "active",
      version: 1,
      updatedAt: "2026-08-04T00:00:00.000Z"
    };
    const parsed = JSON.parse(JSON.stringify({ album, sell, offer })) as { album: CollectionAlbumDto; sell: DuplicatesSellResultDto; offer: PackOfferDto };
    expect(parsed.album.sets.items[0]).toMatchObject({ completionBasisPoints: 3000 });
    expect(parsed.sell.soldItems[0]).toMatchObject({ quantity: 2, unitPrice: { amount: 100 } });
    expect(parsed.sell.skippedItems[0]).toMatchObject({ reason: "quote_unavailable" });
    expect(parsed.offer).toMatchObject({ discountBps: 8000, status: "active" });
  });

  it("I34B 公告 DTO 序列化后不泄露内部系数，热度与 Watchlist DTO 固定形状", () => {
    const announcement: MarketAnnouncementDto = {
      type: "market_event",
      title: "新系列预热",
      scope: "set",
      setCode: "TST",
      setName: "测试系列",
      skuName: null,
      startsAt: "2026-08-04T00:00:00.000Z",
      endsAt: "2026-08-11T00:00:00.000Z",
      reason: "运营活动"
    };
    const heat: MarketHeatDto = {
      intradayGainers: [{ sku: { id: "sku-1", name: "甲", setCode: "TST", setName: "测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare" }, changeBasisPoints: 500, direction: "up", currentPrice: { amount: 105, currency: "GAME_CREDIT" }, basePrice: { amount: 100, currency: "GAME_CREDIT" } }],
      intradayLosers: [],
      sevenDayGainers: [],
      sevenDayLosers: [],
      mostActive: [{ sku: { id: "sku-2", name: "乙", setCode: "TST", setName: "测试系列", collectorNumber: "2", finish: "nonfoil", rarity: "common" }, quantity: 20, turnover: { amount: 2000, currency: "GAME_CREDIT" } }],
      capturedAt: "2026-08-04T00:00:00.000Z"
    };
    const item: WatchlistItemDto = { id: "wl-1", skuId: "sku-1", targetType: "game_price", direction: "at_or_below", targetAmount: 90, enabled: true, createdAt: "2026-08-04T00:00:00.000Z", updatedAt: "2026-08-04T00:00:00.000Z" };
    const alerts: WatchlistAlertsDto = { items: [{ id: "al-1", watchlistItemId: "wl-1", skuId: "sku-1", targetType: "game_price", direction: "at_or_below", targetAmount: 90, triggeredPrice: 85, triggeredAt: "2026-08-04T01:00:00.000Z", read: false }], unreadCount: 1 };
    const book: BilateralOrderBookDto = {
      skuId: "sku-1",
      bids: [{ limitPrice: { amount: 100, currency: "GAME_CREDIT" }, remainingQuantity: 2, cumulativeQuantity: 2, orderCount: 1 }],
      asks: [{ limitPrice: { amount: 110, currency: "GAME_CREDIT" }, remainingQuantity: 3, cumulativeQuantity: 3, orderCount: 1 }],
      midPrice: { amount: 105, currency: "GAME_CREDIT" },
      spread: { amount: 10, currency: "GAME_CREDIT" },
      capturedAt: "2026-08-04T00:00:00.000Z"
    };
    const parsed = JSON.parse(JSON.stringify({ announcement, heat, item, alerts, book })) as {
      announcement: MarketAnnouncementDto;
      heat: MarketHeatDto;
      item: WatchlistItemDto;
      alerts: WatchlistAlertsDto;
      book: BilateralOrderBookDto;
    };
    // 公告绝不暴露内部系数或配置字段。
    expect(parsed.announcement).not.toHaveProperty("factorBps");
    expect(parsed.announcement).not.toHaveProperty("factorBasisPoints");
    expect(parsed.announcement).toMatchObject({ type: "market_event", scope: "set" });
    expect(parsed.heat.intradayGainers[0]).toMatchObject({ changeBasisPoints: 500, direction: "up" });
    expect(parsed.heat.mostActive[0]).toMatchObject({ quantity: 20 });
    expect(parsed.item).toMatchObject({ targetType: "game_price", targetAmount: 90 });
    expect(parsed.alerts).toMatchObject({ unreadCount: 1 });
    expect(parsed.book.bids[0]).toMatchObject({ cumulativeQuantity: 2 });
    expect(parsed.book).toMatchObject({ midPrice: { amount: 105 }, spread: { amount: 10 } });
  });

  it("I35B 任务中心/领取与等级档案 DTO 只承载服务端已结算结果", () => {
    const task: TaskInstanceDto = {
      id: "instance-0001",
      definitionId: "daily-open-3/v1",
      period: "daily",
      periodKey: "2026-08-05",
      title: "每日开包",
      description: "本日开包 3 次",
      metricType: "pack.open",
      currentValue: 3,
      targetAmount: 3,
      rewardAmount: 100,
      status: "claimable",
      claimedAt: null
    };
    const center: TaskCenterDto = {
      daily: [task],
      weekly: [],
      pendingRewardCount: 1,
      period: { day: "2026-08-05", week: "2026-W32" }
    };
    const claim: TaskClaimDto = {
      instanceId: "instance-0001",
      status: "claimed",
      reward: { amount: 100, currency: "GAME_CREDIT" },
      balance: { amount: 10_000, currency: "GAME_CREDIT" }
    };
    const growth: GrowthProfileDto = {
      level: 2,
      title: "资深收藏家",
      totalXp: 200,
      nextLevelXp: 500,
      progressBasisPoints: 0,
      capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 50 },
      peakNetWorth: { amount: 12_000, currency: "GAME_CREDIT" },
      ruleVersion: "level/v1",
      updatedAt: "2026-08-05T00:00:00.000Z"
    };
    const parsed = JSON.parse(JSON.stringify({ task, center, claim, growth }));
    expect(parsed.task).toMatchObject({ period: "daily", status: "claimable", currentValue: 3, targetAmount: 3, rewardAmount: 100, title: "每日开包", metricType: "pack.open" });
    expect(parsed.center).toMatchObject({ pendingRewardCount: 1, period: { day: "2026-08-05", week: "2026-W32" } });
    expect(parsed.claim).toMatchObject({ status: "claimed", reward: { amount: 100 }, balance: { amount: 10_000 } });
    expect(parsed.growth.capabilities).toMatchObject({ npcDailyTradeMultiplier: 1, bulkPackMax: 50 });
    // 任务/等级 DTO 不得携带内部推进来源或未结算字段。
    expect(parsed.task).not.toHaveProperty("factId");
    expect(parsed.growth).not.toHaveProperty("peakNetWorthExcluded");
  });

  it("I35F 玩家首页待办在任务中心有可领取奖励时携带任务入口，只由服务端聚合", () => {
    const withReward: PlayerDashboardDto["todos"] = [
      { id: "claim_daily_work_funding", label: "领取今日工作资金", href: "/dashboard#daily-work-funding-title" },
      { id: "claim_task_rewards", label: "领取任务中心奖励", href: "/tasks" }
    ];
    const parsed = JSON.parse(JSON.stringify({ withReward }));
    expect(parsed.withReward).toContainEqual({ id: "claim_task_rewards", label: "领取任务中心奖励", href: "/tasks" });
  });

  it("I36B 新手引导 DTO 只承载服务端已结算结果，不含内部判定字段", () => {
    const onboarding: OnboardingDto = {
      ruleVersion: "onboarding/v1",
      steps: [
        { id: "claim-work-funds", order: 1, title: "领取工作资金", description: "创建游戏存档并领取今日工作资金", href: "/dashboard", skippable: true, completion: "auto", completedAt: "2026-08-05T01:00:00.000Z", skippedAt: null },
        { id: "open-first-pack", order: 2, title: "开出第一包", description: "购买并开出第一包补充包", href: "/packs", skippable: true, completion: null, completedAt: null, skippedAt: null }
      ],
      completedCount: 1,
      totalCount: 6,
      allCompleted: false,
      currentStepId: "open-first-pack",
      reward: { status: "unavailable", amount: { amount: 500, currency: "GAME_CREDIT" }, claimedAt: null },
      updatedAt: "2026-08-05T01:00:00.000Z"
    };
    const claim: OnboardingRewardClaimDto = {
      status: "claimed",
      reward: { amount: 500, currency: "GAME_CREDIT" },
      balance: { amount: 10_500, currency: "GAME_CREDIT" },
      claimedAt: "2026-08-05T02:00:00.000Z"
    };
    const parsed = JSON.parse(JSON.stringify({ onboarding, claim }));
    expect(parsed.onboarding).toMatchObject({ ruleVersion: "onboarding/v1", completedCount: 1, totalCount: 6, allCompleted: false, currentStepId: "open-first-pack", reward: { status: "unavailable", amount: { amount: 500 } } });
    expect(parsed.onboarding.steps[0]).toMatchObject({ completion: "auto", skippable: true, href: "/dashboard" });
    expect(parsed.claim).toMatchObject({ status: "claimed", reward: { amount: 500 }, balance: { amount: 10_500 } });
    // 引导 DTO 不得携带内部推进来源、贡献值或未结算判定字段。
    expect(parsed.onboarding).not.toHaveProperty("factId");
    expect(parsed.onboarding.steps[1]).not.toHaveProperty("factEventType");
    expect(parsed.onboarding).not.toHaveProperty("profileSnapshot");
  });

  it("I36B 玩家首页待办在引导未完成时携带引导入口，只由服务端聚合", () => {
    const withOnboarding: PlayerDashboardDto["todos"] = [{ id: "continue_onboarding", label: "继续新手引导", href: "/onboarding" }];
    const parsed = JSON.parse(JSON.stringify({ withOnboarding }));
    expect(parsed.withOnboarding).toContainEqual({ id: "continue_onboarding", label: "继续新手引导", href: "/onboarding" });
  });
});
