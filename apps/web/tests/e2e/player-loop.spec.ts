import { expect, test, type Page } from "@playwright/test";

const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const now = "2026-07-30T09:00:00.000Z";
const userId = "10000000-0000-4000-8000-0000000027f0";
const money = (amount: number) => ({ amount, currency: "GAME_CREDIT" as const });
const envelope = (data: unknown) => ({ ok: true, data, meta: { requestId: "i27f-loop" } });

function overview(claimed: boolean) {
  return {
    balance: { total: money(claimed ? 11_000 : 10_000), available: money(claimed ? 11_000 : 10_000), frozen: money(0), updatedAt: now },
    netWorth: money(claimed ? 11_000 : 10_000),
    collection: { distinctSkuCount: 1, totalCardCount: 1, marketValue: money(300), unpricedSkuCount: 0 },
    dailyWorkFunding: { naturalDate: "2026-07-30", timezone: "Asia/Shanghai", status: claimed ? "claimed" : "available", amount: money(1_000), ruleVersion: "daily-work-funds/v1", openedAt: now, nextEligibleAt: "2026-07-31T16:00:00.000Z", claim: claimed ? { id: "daily-i27f", naturalDate: "2026-07-30", timezone: "Asia/Shanghai", amount: money(1_000), ruleVersion: "daily-work-funds/v1", claimedAt: now } : null },
    todayTournaments: { availableCount: 1, registeredCount: 0, settlingCount: 0, settledCount: 0 },
    marketIndex: { referenceIndex: 120, gameIndex: 1_200, quotedSkus: 1, capturedAt: now },
    todos: claimed ? [{ id: "register_tournament", label: "报名今日比赛", href: "/tournaments" }] : [{ id: "claim_daily_work_funding", label: "领取今日工作资金", href: "/dashboard#daily-work-funding-title" }, { id: "register_tournament", label: "报名今日比赛", href: "/tournaments" }],
    capturedAt: now
  };
}

async function session(page: Page) {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i27f-loop-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "i27f-loop-token", user: { id: userId, email: "loop@example.test", displayName: "闭环测试玩家", role: "player", createdAt: now } })) }));
}

/**
 * I27F 的跨页面冒烟链路：各业务写操作的资金/库存/规则断言由对应的 packs、NPC、orders、
 * decks、tournaments、achievements E2E 负责；这里验证浏览器能按服务端已结算状态连续恢复并
 * 进入每个环节，不以客户端计算来补齐任何一步。
 */
test("玩家闭环从工作资金经获得卡牌、交易、构筑、比赛、成就到再投资均有连续浏览器入口", async ({ page }) => {
  // 本用例串联 11+ 个路由，dev 模式每个路由首次按需编译 2–6s，累加后超过默认 30s 单测超时；故单独放宽。
  test.setTimeout(120_000);
  let claimed = false;
  let claimCalls = 0;
  await page.route("**/v1/archive", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ archive: { id: "archive-i27f", userId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now, balance: overview(claimed).balance, netWorth: null } })) }));
  await page.route("**/v1/growth", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ level: 1, title: "见习收藏家", totalXp: 0, nextLevelXp: 200, progressBasisPoints: 0, capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 10 }, peakNetWorth: { amount: 10_000, currency: "GAME_CREDIT" }, ruleVersion: "level/v1", updatedAt: now })) }));
  // I36F：玩家首页新增常驻「新手引导」入口，需补 /v1/onboarding mock（视为已领取完成奖励）。
  await page.route("**/v1/onboarding", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ onboarding: { ruleVersion: "onboarding/v2", steps: [], completedCount: 0, totalCount: 0, allCompleted: true, currentStepId: null, reward: { status: "claimed", amount: money(500), claimedAt: now }, updatedAt: now } })) }));
  await page.route("**/v1/ledger?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/dashboard", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ overview: overview(claimed) })) }));
  await page.route("**/v1/daily-work-funding/claim", async (route) => { claimCalls += 1; claimed = true; await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ funding: overview(true).dailyWorkFunding.claim })) }); });
  await page.route("**/v1/inventory?*", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{ skuId: "30000000-0000-4000-8000-0000000027f0", quantity: 1, availableQuantity: 1, orderLockedQuantity: 0, tournamentLockedQuantity: 0, averageCost: money(300), marketUnitPrice: money(300), marketValue: money(300), unrealizedProfitLoss: money(0), updatedAt: now, marketValueUnavailableReason: null, sku: { id: "30000000-0000-4000-8000-0000000027f0", name: "闭环指挥官", setCode: "LOOP", setName: "闭环系列", collectorNumber: "1", finish: "nonfoil", imagePath: null, tradable: true, manaCost: "{R}", colors: ["R"], colorIdentity: ["R"], typeLine: "Legendary Creature — Test", power: "2", toughness: "2", oracleText: null } }], page: { total: 1, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/catalog/cards/30000000-0000-4000-8000-0000000027f0", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ sku: { id: "30000000-0000-4000-8000-0000000027f0", printingId: "printing-i27f", scryfallId: null, name: "闭环指挥官", setCode: "LOOP", setName: "闭环系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare", manaCost: "{R}", colors: ["R"], colorIdentity: ["R"], typeLine: "Legendary Creature — Test", power: "2", toughness: "2", oracleText: null, artist: null, releasedAt: null, legalities: { commander: "legal" }, source: "manual-test", sourceReference: "i27f", isManualException: true, imagePath: null, tradable: true, image: { path: null, sourceUrl: null, status: "missing", cachedAt: null } } })) }));
  await page.route("**/v1/achievements", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await session(page);

  await page.goto("/dashboard");
  await expect(page.getByText("市场指数", { exact: true })).toBeVisible();
  await expect(page.getByText("1,200")).toBeVisible();
  await page.getByRole("button", { name: "领取 1,000 游戏币" }).dblclick();
  await expect(page.getByRole("button", { name: "今日已领取" })).toBeDisabled();
  expect(claimCalls).toBe(1);

  await page.getByRole("link", { name: "查看收藏册" }).click();
  await expect(page.getByRole("heading", { name: "收藏册" })).toBeVisible();
  await expect(page.getByRole("link", { name: "查看卡牌详情" })).toHaveAttribute("href", "/catalog/30000000-0000-4000-8000-0000000027f0");
  await page.goto("/catalog/30000000-0000-4000-8000-0000000027f0");
  await expect(page.getByRole("dialog", { name: "卡牌详情" })).toBeVisible();
  await expect(page.getByRole("link", { name: "在库存中查看" })).toHaveAttribute("href", /\/inventory\?query=/);
  await expect(page.getByRole("link", { name: "前往比赛" })).toHaveAttribute("href", "/tournaments");

  // 以下入口由已结算服务端事实串联：补充包/NPC 与 P2P 交易获得或处置卡牌，卡组报名比赛，
  // 成就确认奖励后再回补充包进行投资。每个写操作的幂等、重复点击和错误恢复由所属 E2E 专项覆盖。
  for (const [label, href] of [["补充包商店", "/packs"], ["市场", "/market"], ["我的委托", "/orders"], ["我的卡组", "/decks"], ["比赛", "/tournaments"], ["成就", "/achievements"]] as const) {
    await page.goto(href);
    await expect(page.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await page.goto("/dashboard");
  await expect(page.getByText("今日已领取").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "查看收藏册" })).toBeVisible();
});
