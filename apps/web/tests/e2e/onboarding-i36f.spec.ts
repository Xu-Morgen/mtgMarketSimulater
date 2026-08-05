import { expect, test, type Page } from "@playwright/test";

const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const now = "2026-08-05T08:00:00.000Z";
const userId = "10000000-0000-4000-8000-000000000360";

function envelope(data: unknown) {
  return { ok: true, data, meta: { requestId: "i36f-e2e" } };
}

async function session(page: Page) {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i36f-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          accessToken: "i36f-token",
          user: { id: userId, email: "i36f@example.test", displayName: "I36F 测试玩家", role: "player", createdAt: now }
        })
      )
    })
  );
}

const stepDefs = [
  { id: "claim-work-funds", title: "领取工作资金", description: "创建游戏存档并领取今日工作资金，开始你的卡牌交易所之旅", href: "/dashboard" },
  { id: "open-first-pack", title: "开出第一包", description: "在补充包商店购买并开出第一包补充包", href: "/packs" },
  { id: "view-price-history", title: "看懂价格", description: "打开单卡价格历史，查看参考价与游戏内报价的双价格走势", href: "/market/history" },
  { id: "complete-first-npc-trade", title: "完成首笔交易", description: "在市场向 NPC 完成你的第一笔卡牌交易", href: "/market" },
  { id: "unlock-collection-album", title: "收藏见涨", description: "打开收藏图鉴，查看已收集卡牌与系列完成度", href: "/collection/album" },
  { id: "first-tournament-registration", title: "首次报名", description: "构筑合法卡组并报名一场比赛", href: "/tournaments" }
];

/** 引导投影：步骤/完成度/下一步/奖励状态全部来自服务端响应，浏览器不判定完成。 */
function onboardingData(input: Partial<{
  auto: string[];
  skipped: string[];
  rewardStatus: "unavailable" | "available" | "claimed";
}> = {}) {
  const auto = new Set(input.auto ?? []);
  const skipped = new Set(input.skipped ?? []);
  const steps = stepDefs.map((def, index) => {
    const completed = auto.has(def.id);
    const isSkipped = skipped.has(def.id);
    return {
      id: def.id,
      order: index + 1,
      title: def.title,
      description: def.description,
      href: def.href,
      skippable: true,
      completion: isSkipped ? "skip" : completed ? "auto" : null,
      completedAt: completed ? now : null,
      skippedAt: isSkipped ? now : null
    };
  });
  const completedCount = steps.filter((step) => step.completion !== null).length;
  const allCompleted = completedCount === steps.length;
  return {
    ruleVersion: "onboarding/v1",
    steps,
    completedCount,
    totalCount: steps.length,
    allCompleted,
    currentStepId: allCompleted ? null : steps.find((step) => step.completion === null)?.id ?? null,
    reward: {
      status: input.rewardStatus ?? (allCompleted ? "available" : "unavailable"),
      amount: { amount: 500, currency: "GAME_CREDIT" },
      claimedAt: input.rewardStatus === "claimed" ? now : null
    },
    updatedAt: now
  };
}

/** 玩家首页所需的通用 mock（存档/账本/等级/引导入口）。 */
async function mockDashboardCommon(page: Page, onboardingGetter: () => ReturnType<typeof onboardingData>) {
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingGetter() })) }));
  await page.route("**/v1/archive", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          archive: {
            id: "archive-i36f", userId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now,
            balance: { total: { amount: 12_500, currency: "GAME_CREDIT" }, available: { amount: 12_500, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now },
            netWorth: null
          }
        })
      )
    })
  );
  await page.route("**/v1/ledger?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) })
  );
  await page.route("**/v1/growth", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ level: 1, title: "见习收藏家", totalXp: 0, nextLevelXp: 200, progressBasisPoints: 0, capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 10 }, peakNetWorth: { amount: 12_500, currency: "GAME_CREDIT" }, ruleVersion: "level/v1", updatedAt: now })) })
  );
}

async function mockDashboardOverview(page: Page, todos: Array<{ id: string; label: string; href: string }>) {
  await page.route("**/v1/dashboard", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          overview: {
            balance: { total: { amount: 12_500, currency: "GAME_CREDIT" }, available: { amount: 12_500, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now },
            netWorth: { amount: 12_500, currency: "GAME_CREDIT" },
            collection: { distinctSkuCount: 0, totalCardCount: 0, marketValue: { amount: 0, currency: "GAME_CREDIT" }, unpricedSkuCount: 0 },
            dailyWorkFunding: {
              naturalDate: "2026-08-05", timezone: "Asia/Shanghai", status: "claimed", amount: { amount: 1000, currency: "GAME_CREDIT" },
              ruleVersion: "daily-work-funds/v1", openedAt: now, nextEligibleAt: "2026-08-06T16:00:00.000Z",
              claim: { id: "daily-i36f", naturalDate: "2026-08-05", timezone: "Asia/Shanghai", amount: { amount: 1000, currency: "GAME_CREDIT" }, ruleVersion: "daily-work-funds/v1", claimedAt: now }
            },
            todayTournaments: { availableCount: 0, registeredCount: 0, settlingCount: 0, settledCount: 0 },
            marketIndex: { referenceIndex: null, gameIndex: null, quotedSkus: 0, capturedAt: now },
            todos,
            capturedAt: now
          }
        })
      )
    })
  );
}

test("引导页：六步目标链卡片、进度指示、目标入口跳转与「看懂价格」浏览意图提交", async ({ page }) => {
  await session(page);
  const state = { auto: [] as string[], skipped: [] as string[] };
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingData({ auto: state.auto, skipped: state.skipped }) })) }));
  // view_event：价格历史页向服务端提交浏览意图，服务端据此完成「看懂价格」。
  let viewCalls = 0;
  const viewKeys: string[] = [];
  await page.route("**/v1/onboarding/steps/view-price-history/view", async (route) => {
    viewCalls += 1;
    viewKeys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({ path: "/market/history" });
    state.auto = [...state.auto, "view-price-history"];
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingData({ auto: state.auto, skipped: state.skipped }) })) });
  });
  // 价格历史页只读数据 mock（避免访问真实 API；浏览意图本身才是本用例断言目标）。
  await page.route("**/v1/prices/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "fresh" })) }));
  await page.route("**/v1/market/index/history*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ range: "7d", points: [], generatedAt: now })) }));
  await page.route("**/v1/market/quotes?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/market/quotes/*/history*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ skuId: "sku-i36f", range: "30d", points: [], referenceSource: null, generatedAt: now })) }));
  await page.goto("/onboarding");
  // 六步目标链卡片与进度指示：全部来自服务端投影。
  await expect(page.getByRole("heading", { name: "新手引导" })).toBeVisible();
  await expect(page.getByRole("img", { name: "引导进度 0%" })).toBeVisible();
  await expect(page.getByText("已完成 0 / 6 步")).toBeVisible();
  await expect(page.getByText("下一步：领取工作资金")).toBeVisible();
  for (const def of stepDefs) await expect(page.getByRole("heading", { name: def.title })).toBeVisible();
  // 步骤状态徽标与可跳过标志：当前步骤显示「下一步」，其余未完成步骤为「待完成」（6 步中 5 步）。
  await expect(page.getByText("下一步", { exact: true })).toBeVisible();
  await expect(page.getByText("待完成", { exact: true })).toHaveCount(5);
  await expect(page.getByText("可跳过", { exact: true })).toHaveCount(6);
  // 奖励不可领：完成全部步骤前只展示说明。
  await expect(page.getByText("完成全部引导步骤后，由服务器发放一次性奖励。")).toBeVisible();
  // 目标入口直接内嵌在步骤卡片内。
  stepDefs.forEach((def, index) => {
    void expect(page.getByRole("link", { name: "去完成" }).nth(index)).toHaveAttribute("href", def.href);
  });
  // 「看懂价格」入口 → 价格历史页；浏览意图提交且刷新后进度不伪造。
  await page.getByRole("link", { name: "去完成" }).nth(2).click();
  await expect(page).toHaveURL(/\/market\/history/);
  await expect(page.getByRole("heading", { name: "价格历史与市场曲线" })).toBeVisible();
  await expect(page.getByText("已向服务器记录本次价格历史浏览（新手引导「看懂价格」由服务端判定完成）。")).toBeVisible();
  expect(viewCalls).toBe(1);
  expect(viewKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  await page.goto("/onboarding");
  await expect(page.getByRole("img", { name: "引导进度 17%" })).toBeVisible();
  await expect(page.getByText("已完成 1 / 6 步")).toBeVisible();
  await expect(page.getByText("看懂价格", { exact: true })).toBeVisible();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  await page.reload();
  // 刷新后仍只展示服务端持久化进度。
  await expect(page.getByText("已完成 1 / 6 步")).toBeVisible();
  expect(viewCalls).toBe(1);
});

test("跳过与重进：二次确认后只投递一次，跳过永久视为已完成", async ({ page }) => {
  await session(page);
  const state = { auto: [] as string[], skipped: [] as string[] };
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingData({ auto: state.auto, skipped: state.skipped }) })) }));
  let skipCalls = 0;
  const skipKeys: string[] = [];
  await page.route("**/v1/onboarding/steps/claim-work-funds/skip", async (route) => {
    skipCalls += 1;
    skipKeys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 150));
    state.skipped = [...state.skipped, "claim-work-funds"];
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingData({ auto: state.auto, skipped: state.skipped }) })) });
  });
  await page.goto("/onboarding");
  await page.getByRole("button", { name: "跳过此步骤" }).first().click();
  await expect(page.getByRole("dialog", { name: "确认跳过此步骤" })).toBeVisible();
  await page.getByRole("button", { name: "确认" }).dblclick();
  await expect(page.getByRole("dialog", { name: "确认跳过此步骤" })).not.toBeVisible();
  // 只投递一次；跳过视为已完成，下一步前移。
  expect(skipCalls).toBe(1);
  expect(skipKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  await page.reload();
  await expect(page.getByRole("img", { name: "引导进度 17%" })).toBeVisible();
  await expect(page.getByText("已跳过", { exact: true })).toBeVisible();
  await expect(page.getByText("下一步：开出第一包")).toBeVisible();
  // 已跳过的步骤不再提供跳过入口。
  await expect(page.getByRole("button", { name: "跳过此步骤" })).toHaveCount(5);
});

test("完成奖励领取：二次确认 + 幂等键只投递一次，成功横幅展示服务端入账，首页徽标联动", async ({ page }) => {
  await session(page);
  const state = { rewardStatus: "available" as "available" | "claimed" };
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingData({ auto: stepDefs.map((def) => def.id), rewardStatus: state.rewardStatus }) })) }));
  let claimCalls = 0;
  const claimKeys: string[] = [];
  await page.route("**/v1/onboarding/reward/claim", async (route) => {
    claimCalls += 1;
    claimKeys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 150));
    state.rewardStatus = "claimed";
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ reward: { status: "claimed", reward: { amount: 500, currency: "GAME_CREDIT" }, balance: { amount: 13_000, currency: "GAME_CREDIT" }, claimedAt: now } })
      )
    });
  });
  await page.goto("/onboarding");
  // 全部步骤完成：进度 100%、下一步消失、奖励可领取。
  await expect(page.getByRole("img", { name: "引导进度 100%" })).toBeVisible();
  await expect(page.getByText("已完成 6 / 6 步")).toBeVisible();
  await expect(page.getByText("全部步骤已完成，奖励可领取（由服务器入账并写入账本流水）。")).toBeVisible();
  await page.getByRole("button", { name: "领取 500 游戏币" }).click();
  await expect(page.getByRole("dialog", { name: "确认领取引导完成奖励" })).toBeVisible();
  await page.getByRole("button", { name: "确认" }).dblclick();
  // 二次确认关闭、只投递一次；成功横幅只展示服务端入账金额与入账后余额。
  await expect(page.getByRole("dialog", { name: "确认领取引导完成奖励" })).not.toBeVisible();
  await expect(page.getByText("已领取引导完成奖励 500 游戏币，当前可用余额 13,000 游戏币（由服务器入账）。")).toBeVisible();
  expect(claimCalls).toBe(1);
  expect(claimKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  // 状态刷新为已领取，领取按钮消失。
  await expect(page.getByText("已领取，领取时间", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: /领取 500 游戏币/ })).toHaveCount(0);

  // 首页常驻入口与徽标联动：可领取时 badge「引导完成 · 可领取完成奖励」，领取后「引导已完成」。
  await mockDashboardCommon(page, () => onboardingData({ auto: stepDefs.map((def) => def.id), rewardStatus: state.rewardStatus }));
  await mockDashboardOverview(page, state.rewardStatus === "claimed" ? [] : [{ id: "continue_onboarding", label: "继续新手引导", href: "/onboarding" }]);
  await page.goto("/dashboard");
  if (state.rewardStatus === "claimed") {
    await expect(page.getByRole("heading", { name: "新手引导" })).toBeVisible();
    await expect(page.getByText("引导已完成", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "查看新手引导" })).toHaveAttribute("href", "/onboarding");
    // 引导已完成的玩家：待办不再出现 continue_onboarding。
    await expect(page.getByRole("link", { name: "继续新手引导" })).toHaveCount(0);
  } else {
    await expect(page.getByText("引导完成 · 可领取完成奖励", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "继续引导" })).toHaveAttribute("href", "/onboarding");
    await expect(page.getByRole("link", { name: "继续新手引导" })).toHaveAttribute("href", "/onboarding");
  }
});

test("首页常驻入口与徽标：未完成玩家显示引导徽标并跳转引导页；引导与任务进度同源一致", async ({ page }) => {
  await session(page);
  const state = { auto: ["claim-work-funds"] as string[] };
  await mockDashboardCommon(page, () => onboardingData({ auto: state.auto }));
  await mockDashboardOverview(page, [
    { id: "continue_onboarding", label: "继续新手引导", href: "/onboarding" },
    { id: "acquire_cards", label: "获得第一张卡牌", href: "/packs" }
  ]);
  // 任务中心 mock 与引导共用同一已结算事实源：开包事实推进后，引导步骤与任务实例一致反映。
  await page.route("**/v1/tasks", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          daily: [
            {
              id: "task-open-i36f", definitionId: "daily-open-3/v1", period: "daily", periodKey: "2026-08-05",
              title: "每日开包", description: "本日开包 3 次", metricType: "pack.open",
              currentValue: 1, targetAmount: 3, rewardAmount: 100, status: "pending", claimedAt: null
            }
          ],
          weekly: [],
          pendingRewardCount: 0,
          period: { day: "2026-08-05", week: "2026-W32" }
        })
      )
    })
  );
  await page.goto("/dashboard");
  // 未完成玩家：常驻引导入口 + 徽标「引导进行中 1/6」+ 下一步文案 + 待办联动。
  await expect(page.getByRole("heading", { name: "新手引导" })).toBeVisible();
  await expect(page.getByText("引导进行中 1/6", { exact: true })).toBeVisible();
  await expect(page.getByText("下一步：开出第一包")).toBeVisible();
  await expect(page.getByRole("link", { name: "继续引导" })).toHaveAttribute("href", "/onboarding");
  await expect(page.getByRole("link", { name: "继续新手引导" })).toHaveAttribute("href", "/onboarding");
  await page.getByRole("link", { name: "继续新手引导" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "新手引导" })).toBeVisible();
  await expect(page.getByRole("img", { name: "引导进度 17%" })).toBeVisible();
  await expect(page.getByText("已完成", { exact: true })).toBeVisible();
  // 引导与任务进度同源一致：开包事实已在服务端反映为引导「开出第一包」完成 + 任务中心「每日开包」1/3。
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  await expect(page.getByText("每日开包")).toBeVisible();
  await expect(page.getByText("1 / 3", { exact: true })).toBeVisible();
});
