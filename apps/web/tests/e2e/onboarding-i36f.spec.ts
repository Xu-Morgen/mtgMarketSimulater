import { expect, test, type Locator, type Page } from "@playwright/test";

const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const now = "2026-08-05T08:00:00.000Z";
const userId = "10000000-0000-4000-8000-000000000360";

function envelope(data: unknown) {
  return { ok: true, data, meta: { requestId: "i36f-e2e" } };
}

/** 回归所有 Tour 目标：气泡本体不能与当前需要查看/点击的目标矩形相交。 */
async function expectTourNotToCover(tourPanel: Locator, target: Locator) {
  await expect(target).toBeVisible();
  await expect(target).toBeInViewport();
  await expect.poll(async () => {
    const [panelBox, targetBox] = await Promise.all([tourPanel.boundingBox(), target.boundingBox()]);
    if (!panelBox || !targetBox) return true;
    return panelBox.x < targetBox.x + targetBox.width
      && panelBox.x + panelBox.width > targetBox.x
      && panelBox.y < targetBox.y + targetBox.height
      && panelBox.y + panelBox.height > targetBox.y;
  }).toBe(false);
}

/** Tour 的 rootClassName 会同时落到 mask；回归遮罩必须始终覆盖整个视口，不能被气泡宽度截断。 */
async function expectTourMaskToCoverViewport(page: Page) {
  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  await expect.poll(async () => {
    const box = await page.locator(".ant-tour-mask").boundingBox();
    if (!box || !viewport) return false;
    return box.x <= 0.5
      && box.y <= 0.5
      && box.width >= viewport.width - 1
      && box.height >= viewport.height - 1;
  }).toBe(true);
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
  { id: "create-archive", title: "创建存档", description: "点击玩家首页「创建游戏存档」按钮，服务器会初始化你的账户和初始资金", href: "/dashboard" },
  { id: "claim-work-funds", title: "领取工作资金", description: "在玩家首页领取今日工作资金，开始你的卡牌交易所之旅", href: "/dashboard" },
  { id: "open-first-pack", title: "开出第一包", description: "在补充包商店购买并开出第一包补充包", href: "/packs" },
  { id: "view-price-history", title: "看懂价格", description: "打开单卡价格历史，查看参考价与游戏内报价的双价格走势", href: "/market/history" },
  { id: "complete-first-npc-trade", title: "完成首笔交易", description: "在市场向 NPC 完成你的第一笔卡牌交易", href: "/market" },
  { id: "unlock-collection-album", title: "查看收藏", description: "打开收藏图鉴，查看已收集卡牌与系列完成度", href: "/collection/album" },
  { id: "create-first-deck", title: "构筑第一套卡组", description: "从库存选择指挥官并保存合法 Commander 卡组", href: "/decks" },
  { id: "first-tournament-registration", title: "首次报名", description: "使用已保存的合法卡组报名一场比赛", href: "/tournaments" },
  { id: "finish-first-tournament", title: "查看比赛结果", description: "等待服务器结算并查看排名、奖励与重放材料", href: "/tournaments" }
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
    ruleVersion: "onboarding/v3",
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

/** 最小补充包商店 mock：一张可购买包 + 空开包历史，供引导 Tour 高亮「购买并开包」按钮。 */
const activePack = {
  id: "50000000-0000-4000-8000-000000000360",
  code: "ONB-01",
  name: "新手测试补充包",
  description: "用于新手引导跨页高亮的服务端包。",
  price: { amount: 500, currency: "GAME_CREDIT" },
  enabled: true,
  disabledReason: null,
  ruleVersion: "pack/v1",
  updatedAt: now,
  slots: [{ id: "regular", draws: 2, rarityProbabilities: [{ rarity: "common", probabilityBasisPoints: 9000 }, { rarity: "rare", probabilityBasisPoints: 1000 }] }]
};

/** 价格历史页只读数据 mock（浏览意图本身才是断言目标）。 */
async function mockHistoryReads(page: Page) {
  await page.route("**/v1/prices/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "fresh" })) }));
  await page.route("**/v1/market/index/history*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ range: "7d", points: [], generatedAt: now })) }));
  await page.route("**/v1/market/quotes?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/market/quotes/*/history*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ skuId: "sku-i36f", range: "30d", points: [], referenceSource: null, generatedAt: now })) }));
}

test("首次引导完整流程：开始 → 高亮按钮 → 真实完成创建存档/领取资金 → 跨页跟进 → 浏览意图只投递一次", async ({ page }) => {
  // 串联多路由，dev 模式每路由首次按需编译 2–6s，单独放宽超时。
  test.setTimeout(120_000);
  await session(page);
  const state = { hasArchive: false, fundsClaimed: false, auto: [] as string[] };
  const guaranteedSkuId = "30000000-0000-4000-8000-000000000363";
  const guaranteedHolding = { skuId: guaranteedSkuId, quantity: 2, availableQuantity: 2, orderLockedQuantity: 0, tournamentLockedQuantity: 0, averageCost: { amount: 0, currency: "GAME_CREDIT" }, marketUnitPrice: { amount: 132, currency: "GAME_CREDIT" }, marketValue: { amount: 264, currency: "GAME_CREDIT" }, unrealizedProfitLoss: null, updatedAt: now, marketValueUnavailableReason: null, sku: { id: guaranteedSkuId, name: "首包保底卡", setCode: "ONB", setName: "新手系列", collectorNumber: "3", finish: "nonfoil", imagePath: null, tradable: false, manaCost: null, colors: [], colorIdentity: [], typeLine: "Artifact", power: null, toughness: null, oracleText: null } } as const;
  const onboardingGetter = () => onboardingData({ auto: state.auto });
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingGetter() })) }));
  await page.route("**/v1/npc-trades/onboarding-opportunity", (route) => {
    const opportunity = state.auto.includes("complete-first-npc-trade")
      ? { status: "completed", ruleVersion: "onboarding-liquidity/v1" }
      : state.auto.includes("view-price-history")
        ? { status: "available", ruleVersion: "onboarding-liquidity/v1", side: "sell", holding: guaranteedHolding, preview: { skuId: guaranteedSkuId, quantity: 1, availableQuantity: 2, quoteId: "60000000-0000-4000-8000-000000000363", quoteVersion: "market/v1", unitPrice: { amount: 118, currency: "GAME_CREDIT" }, unitFee: { amount: 2, currency: "GAME_CREDIT" }, total: { amount: 118, currency: "GAME_CREDIT" }, fee: { amount: 2, currency: "GAME_CREDIT" }, validUntil: "2099-01-01T00:00:00.000Z", limit: { maxQuantityPerTrade: 20, maxQuantityPerUserSkuDay: 100, remainingQuantityToday: 100 }, canSell: true, unavailableReason: null } }
        : { status: "unavailable", ruleVersion: "onboarding-liquidity/v1", reason: "prerequisite_incomplete" };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ opportunity })) });
  });
  await page.route("**/v1/archive", async (route) => {
    if (route.request().method() === "POST") {
      state.hasArchive = true;
      state.auto = [...state.auto, "create-archive"];
      return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ archive: { id: "archive-i36f", userId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now, balance: { total: { amount: 10_000, currency: "GAME_CREDIT" }, available: { amount: 10_000, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now }, netWorth: null } })) });
    }
    return route.fulfill({ status: state.hasArchive ? 200 : 404, contentType: "application/json", body: JSON.stringify(state.hasArchive ? envelope({ archive: { id: "archive-i36f", userId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now, balance: { total: { amount: 10_000, currency: "GAME_CREDIT" }, available: { amount: 10_000, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now }, netWorth: null } }) : { ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "尚未创建游戏存档" }, meta: { requestId: "i36f-noarchive" } }) });
  });
  await page.route("**/v1/daily-work-funding/claim", async (route) => {
    expect(route.request().postDataJSON()).toEqual({});
    state.fundsClaimed = true;
    state.auto = [...state.auto, "claim-work-funds"];
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ funding: { id: "daily-i36f", naturalDate: "2026-08-05", timezone: "Asia/Shanghai", amount: { amount: 1000, currency: "GAME_CREDIT" }, ruleVersion: "daily-work-funds/v1", claimedAt: now } })) });
  });
  await page.route("**/v1/dashboard", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ overview: {
    balance: { total: { amount: state.hasArchive ? (state.fundsClaimed ? 11_000 : 10_000) : 0, currency: "GAME_CREDIT" }, available: { amount: state.hasArchive ? (state.fundsClaimed ? 11_000 : 10_000) : 0, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now },
    netWorth: null,
    collection: { distinctSkuCount: 0, totalCardCount: 0, marketValue: { amount: 0, currency: "GAME_CREDIT" }, unpricedSkuCount: 0 },
    dailyWorkFunding: {
      naturalDate: "2026-08-05", timezone: "Asia/Shanghai", status: state.fundsClaimed ? "claimed" : "available", amount: { amount: 1000, currency: "GAME_CREDIT" },
      ruleVersion: "daily-work-funds/v1", openedAt: now, nextEligibleAt: "2026-08-06T16:00:00.000Z",
      claim: state.fundsClaimed ? { id: "daily-i36f", naturalDate: "2026-08-05", timezone: "Asia/Shanghai", amount: { amount: 1000, currency: "GAME_CREDIT" }, ruleVersion: "daily-work-funds/v1", claimedAt: now } : null
    },
    todayTournaments: { availableCount: 0, registeredCount: 0, settlingCount: 0, settledCount: 0 },
    marketIndex: { referenceIndex: null, gameIndex: null, quotedSkus: 0, capturedAt: now },
    todos: [],
    capturedAt: now
  } })) }));
  await page.route("**/v1/ledger?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/growth", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ level: 1, title: "见习收藏家", totalXp: 0, nextLevelXp: 200, progressBasisPoints: 0, capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 10 }, peakNetWorth: { amount: 11_000, currency: "GAME_CREDIT" }, ruleVersion: "level/v1", updatedAt: now })) }));
  // 补充包商店与价格历史页只读数据 mock。
  await page.route("**/v1/packs", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [activePack] })) }));
  await page.route("**/v1/pack-openings?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  await mockHistoryReads(page);
  // 步骤自动跳转会进入市场页与收藏图鉴页：补只读 mock 使页面干净渲染（Tour 气泡不受影响）。
  await page.route("**/v1/market/index", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ referenceIndex: 100, gameIndex: 100, quotedSkus: 0, capturedAt: now })) }));
  await page.route("**/v1/market/heat", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ intradayGainers: [], intradayLosers: [], mostActive: [], capturedAt: now })) }));
  await page.route("**/v1/market/announcements", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], capturedAt: now })) }));
  await page.route("**/v1/collection/album?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ sets: { items: [], page: { total: 0, hasMore: false, nextCursor: null } } })) }));
  await page.route("**/v1/achievements", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  // view_event：价格历史页提交浏览意图，服务端据此完成「看懂价格」。
  let viewCalls = 0;
  const viewKeys: string[] = [];
  await page.route("**/v1/onboarding/steps/view-price-history/view", async (route) => {
    viewCalls += 1;
    viewKeys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({ path: "/market/history" });
    state.auto = [...state.auto, "view-price-history"];
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingGetter() })) });
  });

  await page.goto("/dashboard");
  // 未创建存档：常驻引导入口 + 徽标 0/9；「继续引导」启动 Tour。
  await expect(page.getByText("引导进行中 0/9", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "继续引导" }).click();
  const tourPanel = page.locator(".ant-tour-panel");
  await expect(tourPanel).toBeVisible();
  // 第一步：创建存档，气泡高亮首页「创建游戏存档」按钮。
  await expect(tourPanel.getByText("下一步：创建存档", { exact: true })).toBeVisible();
  await expect(tourPanel.getByText(/点击玩家首页「创建游戏存档」按钮/)).toBeVisible();
  await expect(page.locator("#onboarding-create-archive")).toBeVisible();
  // 真实点击目标按钮完成第一步：点击高亮按钮后，步骤完成（服务端推进）自动前进到「领取工作资金」
  // 并滚动到领取卡片（同一 /dashboard 页）。
  await page.locator("#onboarding-create-archive").click();
  await expect(tourPanel.getByText("下一步：领取工作资金", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
  // 回归：创建存档后首页从「未存档」分支切换并重拉概览，每日工作资金卡片与领取按钮晚于步骤切换
  // 才挂载；Tour 应优先重新定位到按钮，气泡说明不能拼出 undefined，也不能继续框选整卡遮挡按钮。
  await expect(page.locator("#onboarding-work-funds")).toBeVisible();
  await expect(page.locator("#onboarding-work-funds")).toBeInViewport();
  const workFundsButton = page.locator("#onboarding-work-funds-claim");
  await expect(tourPanel).not.toContainText("undefined");
  await expectTourMaskToCoverViewport(page);
  await expectTourNotToCover(tourPanel, workFundsButton);
  await workFundsButton.click();
  // 领取资金完成（点击高亮按钮）：自动前进到「开出第一包」并跳转补充包商店。
  await expect(page).toHaveURL(/\/packs$/);
  await expect(tourPanel.getByText("下一步：开出第一包", { exact: true })).toBeVisible();
  await expect(page.locator("#onboarding-pack-purchase")).toBeVisible();
  await expect(page.locator("#onboarding-pack-purchase")).toBeInViewport();
  await expectTourNotToCover(tourPanel, page.locator("#onboarding-pack-purchase"));
  // 真实完成购买开包：购买弹窗必须渲染在引导蒙层之上（z-index 1200 > Tour 蒙层 1100），
  // 否则弹窗被蒙层盖住、开包按钮无法点击，表现为引导卡死。
  let openCalls = 0;
  const openKeys: string[] = [];
  // 开包结果卡展示所需的卡牌详情/报价以 404 兜底（不影响开包结果与引导流程）。
  await page.route("**/v1/catalog/cards/30000000-0000-4000-8000-00000000036*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "卡牌不存在" }, meta: { requestId: "i36f-card" } }) }));
  await page.route("**/v1/market/quotes/30000000-0000-4000-8000-00000000036*", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "暂无报价" }, meta: { requestId: "i36f-quote" } }) }));
  await page.route("**/v1/store/packs/50000000-0000-4000-8000-000000000360/purchase-preview", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ preview: { pack: activePack, ruleVersion: "pack/v1", cost: { amount: 500, currency: "GAME_CREDIT" }, canPurchase: true, unavailableReason: null } })
      )
    })
  );
  await page.route("**/v1/packs/50000000-0000-4000-8000-000000000360/open", async (route) => {
    openCalls += 1;
    openKeys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({ ruleVersion: "pack/v1" });
    state.auto = [...state.auto, "open-first-pack"];
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          opening: {
            id: "opening-i36f", packId: activePack.id, packRuleVersion: "pack/v1",
            spent: { amount: 500, currency: "GAME_CREDIT" },
            received: [
              { skuId: "30000000-0000-4000-8000-000000000361", quantity: 1, cost: { amount: 250, currency: "GAME_CREDIT" }, referencePrice: null, gamePrice: null, priceStatus: "unavailable_until_i17", isNewToCollection: true, collectionProgressAfter: { setCode: "ONB", collected: 1, total: 2, basisPoints: 5000 } },
              { skuId: "30000000-0000-4000-8000-000000000362", quantity: 1, cost: { amount: 250, currency: "GAME_CREDIT" }, referencePrice: null, gamePrice: null, priceStatus: "unavailable_until_i17", isNewToCollection: true, collectionProgressAfter: { setCode: "ONB", collected: 1, total: 2, basisPoints: 5000 } }
            ],
            profitLoss: { spent: { amount: 500, currency: "GAME_CREDIT" }, referenceValue: null, gameValue: null, referenceProfitLoss: null, gameProfitLoss: null, priceStatus: "unavailable_until_i17" },
            totalCost: { amount: 500, currency: "GAME_CREDIT" }, totalGameValue: null, openedAt: now
          }
        })
      )
    });
  });
  await page.locator("#onboarding-pack-purchase").click();
  // 购买弹窗打开后，Tour 目标自动切换到弹窗内的「确认购买并开包」按钮（多锚点按序解析）：
  // rc-tour 蒙层在目标位置留出可点击孔洞，点击穿透到弹窗按钮；弹窗本身仍在蒙层之下（z-index 10）。
  await expect(page.getByRole("dialog", { name: "购买补充包" })).toBeVisible();
  await expect(page.getByText("本次扣款：500 游戏币")).toBeVisible();
  await expect(tourPanel.getByText(/购买弹窗已打开：点击下方「确认购买并开包」完成本步/)).toBeVisible();
  await expect(page.locator("#onboarding-pack-confirm")).toBeVisible();
  await expect(page.locator("#onboarding-pack-confirm")).toBeInViewport();
  await expectTourNotToCover(tourPanel, page.locator("#onboarding-pack-confirm"));
  await page.locator("#onboarding-pack-confirm").dblclick();
  expect(openCalls).toBe(1);
  expect(openKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  // 开包完成后等待翻牌动画结束，再自动前进到价格历史；不得在服务端响应刚到时抢跑切页。
  await expect(page).toHaveURL(/\/market\/history/);
  await expect(tourPanel.getByText("下一步：看懂价格", { exact: true })).toBeVisible();
  await expectTourNotToCover(tourPanel, page.locator("#onboarding-view-price-history-focus"));
  // 页面挂载不能立即提交 view_event 或跳走；至少保留 6 秒阅读时间，再由玩家明确确认。
  await expect(page.getByRole("button", { name: "请先阅读价格走势（6 秒）" })).toBeDisabled();
  await page.waitForTimeout(1_000);
  await expect(page).toHaveURL(/\/market\/history/);
  expect(viewCalls).toBe(0);
  const confirmPriceView = page.locator("#onboarding-price-history-confirm");
  await expect(confirmPriceView).toBeVisible({ timeout: 8_000 });
  await expectTourNotToCover(tourPanel, confirmPriceView);
  await confirmPriceView.click();
  await expect.poll(() => viewCalls).toBe(1);
  expect(viewKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  // 浏览意图由服务端确认后走同一状态转换，自动进入首笔交易。
  await expect(page).toHaveURL(/\/market$/);
  await expect(tourPanel.getByText("下一步：完成首笔交易", { exact: true })).toBeVisible();
  // 即使普通市场列表为空/全部停用，服务端也必须给当前教程阶段提供一张首包持仓的保底卖出机会。
  await expect(page.locator("#onboarding-npc-buy")).toHaveCount(0);
  const guaranteedTrade = page.locator("#onboarding-npc-guaranteed-trade");
  await expect(guaranteedTrade).toBeVisible();
  await expect(guaranteedTrade).toBeInViewport();
  await expectTourNotToCover(tourPanel, guaranteedTrade);
  let sellCalls = 0;
  const sellKeys: string[] = [];
  const guaranteedQuoteId = "60000000-0000-4000-8000-000000000363";
  await page.route(`**/v1/npc-trades/sell/${guaranteedSkuId}/preview?quantity=1`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ preview: { skuId: guaranteedSkuId, quantity: 1, availableQuantity: 2, quoteId: guaranteedQuoteId, quoteVersion: "market/v1", unitPrice: { amount: 118, currency: "GAME_CREDIT" }, unitFee: { amount: 2, currency: "GAME_CREDIT" }, total: { amount: 118, currency: "GAME_CREDIT" }, fee: { amount: 2, currency: "GAME_CREDIT" }, validUntil: "2099-01-01T00:00:00.000Z", limit: { maxQuantityPerTrade: 20, maxQuantityPerUserSkuDay: 100, remainingQuantityToday: 100 }, canSell: true, unavailableReason: null } })
      )
    })
  );
  await page.route(`**/v1/npc-trades/sell/${guaranteedSkuId}`, async (route) => {
    sellCalls += 1;
    sellKeys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toMatchObject({ quoteId: guaranteedQuoteId, quoteVersion: "market/v1", quantity: 1, minUnitPrice: 118 });
    state.auto = [...state.auto, "complete-first-npc-trade"];
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          trade: { id: "trade-i36f", userId, skuId: guaranteedSkuId, side: "sell", quantity: 1, quoteId: guaranteedQuoteId, quoteVersion: "market/v1", unitPrice: { amount: 118, currency: "GAME_CREDIT" }, unitFee: { amount: 2, currency: "GAME_CREDIT" }, total: { amount: 118, currency: "GAME_CREDIT" }, fee: { amount: 2, currency: "GAME_CREDIT" }, settledAt: now },
          balance: { total: { amount: 11_118, currency: "GAME_CREDIT" }, available: { amount: 11_118, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now },
          holding: { ...guaranteedHolding, quantity: 1, availableQuantity: 1, marketValue: { amount: 132, currency: "GAME_CREDIT" } }
        })
      )
    });
  });
  await guaranteedTrade.click();
  await expect(page.getByRole("dialog", { name: "向 NPC 卖出" })).toBeVisible();
  await expect(page.getByText("新手保底机会固定交易 1 张")).toBeVisible();
  await expect(page.getByRole("button", { name: "全部可用库存" })).toHaveCount(0);
  await expect(tourPanel.getByText(/卖出确认弹窗已打开：点击下方「确认向 NPC 卖出」完成本步/)).toBeVisible();
  await expect(page.locator("#onboarding-npc-sell-confirm")).toBeVisible();
  await expect(page.locator("#onboarding-npc-sell-confirm")).toBeInViewport();
  await expectTourNotToCover(tourPanel, page.locator("#onboarding-npc-sell-confirm"));
  await page.locator("#onboarding-npc-sell-confirm").dblclick();
  expect(sellCalls).toBe(1);
  expect(sellKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  // 交易完成（点击高亮确认按钮）：自动前进到「查看收藏」并跳转收藏图鉴页。
  await expect(page).toHaveURL(/\/collection\/album/);
  await expect(tourPanel.getByText("下一步：查看收藏", { exact: true })).toBeVisible();
  await expectTourNotToCover(tourPanel, page.locator("#onboarding-collection-album-focus"));
  // 关闭 Tour：结束引导会话，气泡消失。
  await page.locator(".ant-tour-close").click();
  await expect(tourPanel).toHaveCount(0);
  // 返回引导页：进度只来自服务端投影（创建存档/领取资金/开包/看价/交易共 5 步完成，收藏/报名待办）。
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "新手引导" })).toBeVisible();
  await expect(page.getByText("已完成 5 / 9 步")).toBeVisible();
  await expect(page.getByRole("img", { name: "引导进度 56%" })).toBeVisible();
  await expect(page.getByText("下一步：查看收藏").first()).toBeVisible();
});

test("跳过与重进：Tour 内跳过只投递一次，已跳过步骤不可再跳，刷新后不伪造进度", async ({ page }) => {
  test.setTimeout(90_000);
  await session(page);
  const state = { auto: [] as string[] };
  const onboardingGetter = () => onboardingData({ auto: state.auto });
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingGetter() })) }));
  await page.route("**/v1/archive", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "尚未创建游戏存档" }, meta: { requestId: "i36f-noarchive" } }) }));
  await page.route("**/v1/ledger?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/growth", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ level: 1, title: "见习收藏家", totalXp: 0, nextLevelXp: 200, progressBasisPoints: 0, capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 10 }, peakNetWorth: { amount: 10_000, currency: "GAME_CREDIT" }, ruleVersion: "level/v1", updatedAt: now })) }));
  await page.route("**/v1/dashboard", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "尚未创建游戏存档" }, meta: { requestId: "i36f-noarchive" } }) }));
  let skipCalls = 0;
  const skipKeys: string[] = [];
  await page.route("**/v1/onboarding/steps/create-archive/skip", async (route) => {
    skipCalls += 1;
    skipKeys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 150));
    state.auto = [...state.auto, "create-archive"];
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingGetter() })) });
  });
  await page.goto("/dashboard");
  await page.getByRole("button", { name: "继续引导" }).click();
  const tourPanel = page.locator(".ant-tour-panel");
  await expect(tourPanel.getByText("下一步：创建存档", { exact: true })).toBeVisible();
  await tourPanel.getByRole("button", { name: "跳过此步" }).dblclick();
  // 只投递一次；跳过由服务端确认后自动前进到下一步。
  expect(skipCalls).toBe(1);
  expect(skipKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  await expect(tourPanel.getByText("下一步：领取工作资金", { exact: true })).toBeVisible();
  // 上一步回到已跳过步骤：显示「已完成」，不再提供跳过入口。
  await tourPanel.getByRole("button", { name: "上一步" }).click();
  await expect(tourPanel.getByText("创建存档（已完成）", { exact: true })).toBeVisible();
  await expect(tourPanel.getByRole("button", { name: "跳过此步" })).toHaveCount(0);
  // 关闭并刷新：进度仍只来自服务端投影（进入 /onboarding 会由 Tour 自动开始会话，取第一个「下一步」）。
  await page.locator(".ant-tour-close").click();
  await page.goto("/onboarding");
  await expect(page.getByRole("img", { name: "引导进度 11%" })).toBeVisible();
  await expect(page.getByText("已完成 1 / 9 步")).toBeVisible();
  await expect(page.getByText("已跳过", { exact: true })).toBeVisible();
  await expect(page.getByText("下一步：领取工作资金").first()).toBeVisible();
});

test("完成奖励领取：二次确认 + 幂等键只投递一次，成功横幅展示服务端入账", async ({ page }) => {
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
  // 全部九步完成：进度 100%、下一步消失、奖励可领取。
  await expect(page.getByRole("img", { name: "引导进度 100%" })).toBeVisible();
  await expect(page.getByText("已完成 9 / 9 步")).toBeVisible();
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
});

test("玩家首页：引导入口徽标与服务端待办「继续新手引导」联动", async ({ page }) => {
  await session(page);
  const state = { auto: ["create-archive"] as string[] };
  await mockDashboardCommon(page, () => onboardingData({ auto: state.auto }));
  await mockDashboardOverview(page, [
    { id: "continue_onboarding", label: "继续新手引导", href: "/onboarding" },
    { id: "acquire_cards", label: "获得第一张卡牌", href: "/packs" }
  ]);
  await page.goto("/dashboard");
  // 未完成玩家：常驻引导入口 + 徽标「引导进行中 1/9」+ 下一步文案 + 待办联动。
  await expect(page.getByRole("heading", { name: "新手引导" })).toBeVisible();
  await expect(page.getByText("引导进行中 1/9", { exact: true })).toBeVisible();
  await expect(page.getByText("下一步：领取工作资金")).toBeVisible();
  await expect(page.getByRole("button", { name: "继续引导" })).toBeVisible();
  await expect(page.getByRole("link", { name: "继续新手引导" })).toHaveAttribute("href", "/onboarding");
  await page.getByRole("link", { name: "继续新手引导" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  await expect(page.getByRole("heading", { name: "新手引导" })).toBeVisible();
  await expect(page.getByRole("img", { name: "引导进度 11%" })).toBeVisible();
});

test("未创建存档的新玩家首页展示常驻引导入口，可启动 Tour 引导第一步「创建存档」", async ({ page }) => {
  await session(page);
  await page.route("**/v1/archive", (route) =>
    route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "尚未创建游戏存档" }, meta: { requestId: "i36f-noarchive" } }) })
  );
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingData() })) }));
  await page.route("**/v1/dashboard", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "尚未创建游戏存档" }, meta: { requestId: "i36f-noarchive" } }) }));
  await page.route("**/v1/growth", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ level: 1, title: "见习收藏家", totalXp: 0, nextLevelXp: 200, progressBasisPoints: 0, capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 10 }, peakNetWorth: { amount: 0, currency: "GAME_CREDIT" }, ruleVersion: "level/v1", updatedAt: now })) }));
  await page.goto("/dashboard");
  // 未创建存档分支：创建存档 CTA 与常驻新手引导入口并存，徽标显示全部待办 0/9。
  await expect(page.getByText("尚未创建游戏存档")).toBeVisible();
  await expect(page.getByRole("button", { name: "创建游戏存档" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "新手引导" })).toBeVisible();
  await expect(page.getByText("引导进行中 0/9", { exact: true })).toBeVisible();
  await expect(page.getByText("下一步：创建存档")).toBeVisible();
  // 「继续引导」直接启动 Tour：第一步高亮「创建存档」按钮（引导第一步即创建存档）。
  await page.getByRole("button", { name: "继续引导" }).click();
  const tourPanel = page.locator(".ant-tour-panel");
  await expect(tourPanel.getByText("下一步：创建存档", { exact: true })).toBeVisible();
  await expect(page.locator("#onboarding-create-archive")).toBeVisible();
  await expect(page.locator("#onboarding-create-archive")).toBeInViewport();
  // 关闭 Tour 后进度刷新仍为服务端投影。
  await page.locator(".ant-tour-close").click();
  await expect(tourPanel).toHaveCount(0);
  await expect(page.getByText("引导进行中 0/9", { exact: true })).toBeVisible();
});

test("侧栏「新手引导」先弹确认框，确认后跳到当前步骤路由并启动 Tour；关闭后不再自动重新弹出", async ({ page }) => {
  test.setTimeout(90_000);
  await session(page);
  // 当前未完成步骤为「开出第一包」（创建存档/领取资金已完成）。
  const state = { auto: ["create-archive", "claim-work-funds"] as string[] };
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingData({ auto: state.auto }) })) }));
  // 跳到 /packs 所需的补充包商店只读 mock。
  await page.route("**/v1/packs", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [activePack] })) }));
  await page.route("**/v1/pack-openings?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  await mockHistoryReads(page);
  await page.route("**/v1/archive", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "尚未创建游戏存档" }, meta: { requestId: "i36f-noarchive" } }) }));
  await page.route("**/v1/ledger?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/growth", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ level: 1, title: "见习收藏家", totalXp: 0, nextLevelXp: 200, progressBasisPoints: 0, capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 10 }, peakNetWorth: { amount: 11_000, currency: "GAME_CREDIT" }, ruleVersion: "level/v1", updatedAt: now })) }));
  await page.route("**/v1/dashboard", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "尚未创建游戏存档" }, meta: { requestId: "i36f-noarchive" } }) }));

  await page.goto("/dashboard");
  const tourPanel = page.locator(".ant-tour-panel");
  // 侧栏「新手引导」是按钮：点击先弹确认框（不直接跳转）。
  await page.getByLabel("玩家导航").getByRole("button", { name: "新手引导" }).click();
  await expect(page.getByRole("dialog", { name: "开启新手引导" })).toBeVisible();
  await expect(page.getByText(/创建存档 → 领取工作资金 → 开出第一包/)).toBeVisible();
  // 确认：跳到当前未完成步骤「开出第一包」所在路由 /packs，并启动 Tour 高亮「购买并开包」按钮。
  await page.getByRole("dialog", { name: "开启新手引导" }).getByRole("button", { name: "确认" }).click();
  await expect(page).toHaveURL(/\/packs$/);
  await expect(tourPanel.getByText("下一步：开出第一包", { exact: true })).toBeVisible();
  await expect(page.locator("#onboarding-pack-purchase")).toBeVisible();
  await expect(page.locator("#onboarding-pack-purchase")).toBeInViewport();
  // 关闭 Tour：气泡消失且不再自动重新弹出（关闭只允许从引导入口再次显式开启）。
  await page.locator(".ant-tour-close").click();
  await expect(tourPanel).toHaveCount(0);
  // 导航到引导页：不会自动重启 Tour（此前已显式关闭）。
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "新手引导" })).toBeVisible();
  await expect(page.getByText("已完成 2 / 9 步")).toBeVisible();
  await page.waitForTimeout(600);
  await expect(tourPanel).toHaveCount(0);
  // 在引导页显式「开始引导」可重新开启（清除已关闭标记）。
  await page.getByRole("button", { name: "开始引导" }).click();
  await expect(tourPanel.getByText("下一步：开出第一包", { exact: true })).toBeVisible();
});

test("组卡是报名之前的独立服务端步骤，Tour 先进入卡组页且不能直接越过", async ({ page }) => {
  test.setTimeout(90_000);
  await session(page);
  // 前六步已完成，当前步骤必须是「构筑第一套卡组」，不能直接跳到报名。
  const state = { auto: stepDefs.slice(0, 6).map((def) => def.id) as string[], hasDeck: false, hasCommander: false };
  const commanderSkuId = "30000000-0000-4000-8000-000000000399";
  const commanderHolding = { skuId: commanderSkuId, quantity: 1, availableQuantity: 1, orderLockedQuantity: 0, tournamentLockedQuantity: 0, averageCost: { amount: 202, currency: "GAME_CREDIT" }, marketUnitPrice: { amount: 200, currency: "GAME_CREDIT" }, marketValue: { amount: 200, currency: "GAME_CREDIT" }, unrealizedProfitLoss: { amount: -2, currency: "GAME_CREDIT" }, updatedAt: now, marketValueUnavailableReason: null, sku: { id: commanderSkuId, name: "新手传奇指挥官", setCode: "ONB", setName: "新手系列", collectorNumber: "99", finish: "nonfoil", imagePath: null, tradable: true, manaCost: "{2}{R}", colors: ["R"], colorIdentity: ["R"], typeLine: "Legendary Creature — Human", power: "3", toughness: "3", oracleText: null } } as const;
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: onboardingData({ auto: state.auto }) })) }));
  await page.route("**/v1/decks", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: state.hasDeck ? [{ id: "deck-i36f", name: "新手卡组", format: "commander-100/v1", ruleVersion: "commander-100/v1", banlistVersion: "commander-banlist/2026-08-05", cards: [], legality: { valid: true, totalCards: 100, colorIdentity: ["R"], issues: [], ruleVersion: "commander-100/v1", banlistVersion: "commander-banlist/2026-08-05", checkedAt: now }, strengthSnapshot: null, createdAt: now, updatedAt: now }] : [] })) }));
  // /decks 页所需的库存只读 mock（新建卡组页会读取可用库存）。
  await page.route("**/v1/inventory?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: state.hasCommander ? [commanderHolding] : [], page: { total: state.hasCommander ? 1 : 0, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/prices/status", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "fresh" })) }));
  await page.route("**/v1/market/index", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ referenceIndex: 200, gameIndex: 200, quotedSkus: 1, capturedAt: now })) }));
  await page.route("**/v1/market/heat", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ intradayGainers: [], intradayLosers: [], mostActive: [], capturedAt: now })) }));
  await page.route("**/v1/market/announcements", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], capturedAt: now })) }));
  await page.route("**/v1/npc-trades/onboarding-opportunity", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ opportunity: { status: "unavailable", ruleVersion: "onboarding-liquidity/v1", reason: "prerequisite_incomplete" } })) }));
  await page.route("**/v1/market/quotes?*", (route) => {
    const url = new URL(route.request().url());
    expect(url.searchParams.get("cardRole")).toBe("commander");
    expect(url.searchParams.get("tradable")).toBe("tradable");
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{ sku: { id: commanderSkuId, name: "新手传奇指挥官", setCode: "ONB", setName: "新手系列", collectorNumber: "99", finish: "nonfoil", rarity: "rare", imagePath: null, typeLine: "Legendary Creature — Human" }, quote: { skuId: commanderSkuId, quoteVersion: "market/v1", referencePrice: { amount: 180, currency: "EUR" }, marketPrice: { amount: 200, currency: "GAME_CREDIT" }, npcBuyPrice: { amount: 180, currency: "GAME_CREDIT" }, npcSellPrice: { amount: 202, currency: "GAME_CREDIT" }, validUntil: "2099-01-01T00:00:00.000Z", source: "mtgjson-cardmarket", capturedAt: now, reasons: [] }, tradable: true, tradeDisabledReason: null }], page: { total: 1, hasMore: false, nextCursor: null } })) });
  });
  await page.route(`**/v1/npc-trades/buy/${commanderSkuId}/preview?quantity=1`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: { skuId: commanderSkuId, quantity: 1, quoteId: "60000000-0000-4000-8000-000000000399", quoteVersion: "market/v1", unitPrice: { amount: 202, currency: "GAME_CREDIT" }, unitFee: { amount: 2, currency: "GAME_CREDIT" }, total: { amount: 202, currency: "GAME_CREDIT" }, fee: { amount: 2, currency: "GAME_CREDIT" }, validUntil: "2099-01-01T00:00:00.000Z", limit: { maxQuantityPerTrade: 1000, maxQuantityPerUserSkuDay: 1000, remainingQuantityToday: 1000 }, canPurchase: true, unavailableReason: null } })) }));
  let commanderBuyCalls = 0;
  await page.route(`**/v1/npc-trades/buy/${commanderSkuId}`, (route) => {
    commanderBuyCalls += 1;
    state.hasCommander = true;
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ trade: { id: "trade-commander-i36f", userId, skuId: commanderSkuId, side: "buy", quantity: 1, quoteId: "60000000-0000-4000-8000-000000000399", quoteVersion: "market/v1", unitPrice: { amount: 202, currency: "GAME_CREDIT" }, unitFee: { amount: 2, currency: "GAME_CREDIT" }, total: { amount: 202, currency: "GAME_CREDIT" }, fee: { amount: 2, currency: "GAME_CREDIT" }, settledAt: now }, balance: { total: { amount: 10_798, currency: "GAME_CREDIT" }, available: { amount: 10_798, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now }, holding: commanderHolding })) });
  });
  // 赛事页只读 mock（今日比赛列表空）。
  await page.route("**/v1/tournaments", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await page.route("**/v1/tournaments/history", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await page.route("**/v1/tournament-pack-grants", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await page.route("**/v1/player-tournament-pack-grants", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await page.route("**/v1/player-tournaments", (route) => route.request().method() === "GET" ? route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }) : route.fallback());
  await page.route("**/v1/archive", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "尚未创建游戏存档" }, meta: { requestId: "i36f-noarchive" } }) }));
  await page.route("**/v1/ledger?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/growth", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ level: 1, title: "见习收藏家", totalXp: 0, nextLevelXp: 200, progressBasisPoints: 0, capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 10 }, peakNetWorth: { amount: 11_000, currency: "GAME_CREDIT" }, ruleVersion: "level/v1", updatedAt: now })) }));
  await page.route("**/v1/dashboard", (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "RESOURCE_NOT_FOUND", message: "尚未创建游戏存档" }, meta: { requestId: "i36f-noarchive" } }) }));

  await page.goto("/onboarding");
  const tourPanel = page.locator(".ant-tour-panel");
  await expect(tourPanel.getByText("下一步：构筑第一套卡组", { exact: true })).toBeVisible();
  // 点击「去完成 →」进入卡组页。
  await tourPanel.getByRole("button", { name: "去完成 →" }).click();
  // 路由切换门禁：点击后主按钮暂时禁用（「正在切换页面…」），切换完成恢复。
  await expect(page).toHaveURL(/\/decks$/);
  await expect(page.locator("#onboarding-decks")).toBeVisible();
  await expect(page.locator("#onboarding-decks")).toBeInViewport();
  await expectTourNotToCover(tourPanel, page.locator("#onboarding-decks"));
  await expect(tourPanel.getByText(/构筑顺序|合法 Commander 卡组必须有/)).toBeVisible();
  await expect(tourPanel.getByRole("button", { name: "请完成高亮操作" })).toBeDisabled();
  await expect(page).not.toHaveURL(/\/tournaments$/);
  // 进入编辑器后没有指挥官：高亮采购链接；跳到市场后不能再显示通用“去卡组页”造成循环。
  await page.locator("#onboarding-decks").click();
  await expect(page).toHaveURL(/\/decks\/new$/);
  const acquireCommander = page.locator("#onboarding-deck-acquire-commander");
  await expect(acquireCommander).toBeVisible();
  await expectTourNotToCover(tourPanel, acquireCommander);
  await acquireCommander.click();
  await expect(page).toHaveURL(/\/market\?.*onboarding=commander/);
  const commanderBuy = page.locator("#onboarding-commander-buy");
  await expect(commanderBuy).toBeVisible();
  await expect(commanderBuy).toHaveText("向 NPC 买入这张指挥官");
  await expect(page.getByRole("heading", { name: "行情屏" })).toHaveCount(0);
  await expect(tourPanel.getByText(/市场已只显示可用的传奇生物候选/)).toBeVisible();
  await expect(tourPanel.getByRole("button", { name: "请完成高亮操作" })).toBeDisabled();
  await expectTourNotToCover(tourPanel, commanderBuy);
  await commanderBuy.click();
  await expect(page.getByRole("dialog", { name: "向 NPC 买入" })).toBeVisible();
  await expect(tourPanel.getByText(/确认购买这张传奇生物/)).toBeVisible();
  await page.locator("#onboarding-npc-confirm").click();
  expect(commanderBuyCalls).toBe(1);
  // 成交后自动回到原构筑，卡组专用库存缓存必须刷新并高亮新买到的传奇生物。
  await expect(page).toHaveURL(/\/decks\/new$/);
  await expect(page.locator("#onboarding-deck-commander")).toBeVisible();
  await expect(tourPanel.getByText(/先从可用库存选择一位传奇生物/)).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page).toHaveURL(/\/decks\/new$/);
});
