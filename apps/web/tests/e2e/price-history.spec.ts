import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-27T08:00:00.000Z";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";

const skuId = "30000000-0000-4000-8000-000000000171";
const quotedItem = {
  sku: { id: skuId, name: "价格历史夹具卡", setCode: "TST", setName: "测试系列", collectorNumber: "171", finish: "nonfoil", rarity: "rare" },
  quote: { skuId, quoteVersion: "market/v1", referencePrice: { amount: 120, currency: "EUR" }, marketPrice: { amount: 144, currency: "GAME_CREDIT" }, npcBuyPrice: { amount: 130, currency: "GAME_CREDIT" }, npcSellPrice: { amount: 160, currency: "GAME_CREDIT" }, validUntil: now, source: "mtgjson-cardmarket", capturedAt: now, reasons: [] },
  tradable: true,
  tradeDisabledReason: null
};

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i17f-e2e" } }; }

async function recoverPlayerSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "history-e2e-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(envelope({
      accessToken: "history-e2e-token",
      user: { id: "10000000-0000-4000-8000-000000000171", email: "history-e2e@example.test", displayName: "历史测试玩家", role: "player", createdAt: now }
    }))
  }));
  // I36F：价格历史页挂载时向服务端提交新手引导「看懂价格」浏览意图（view_event），
  // 这里 stub 返回成功，避免测试访问真实 API；不参与本 spec 的断言。
  await page.route("**/v1/onboarding/steps/view-price-history/view", async (route) => route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify(envelope({ onboarding: { ruleVersion: "onboarding/v3", steps: [], completedCount: 0, totalCount: 0, allCompleted: false, currentStepId: "view-price-history", reward: { status: "unavailable", amount: { amount: 500, currency: "GAME_CREDIT" }, claimedAt: null }, updatedAt: now } }))
  }));
}

async function stubPriceStatus(page: Page, freshness: "fresh" | "stale" | "unavailable" = "fresh", source: "mtgjson-cardmarket" | null = "mtgjson-cardmarket"): Promise<void> {
  await page.route("**/v1/prices/status", async (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(envelope({ source, updatedAt: now, freshness, disclaimer: "MTGJSON / Cardmarket EUR 每日参考快照；游戏内价为虚拟货币游戏币，非实时、非真实资产。" }))
  }));
}

function indexHistoryPayload(range: "7d" | "30d" | "all") {
  const points = [
    { date: range === "7d" ? "2026-07-24" : "2026-07-20", referenceIndex: 118, gameIndex: 142 },
    { date: "2026-07-26", referenceIndex: null, gameIndex: 150 },
    { date: "2026-07-27", referenceIndex: 123, gameIndex: 148 }
  ];
  return envelope({ range, points, generatedAt: now });
}

function skuHistoryPayload(range: "7d" | "30d" | "all") {
  const points = [
    { date: range === "7d" ? "2026-07-24" : "2026-07-20", referencePrice: { amount: 115, currency: "EUR" }, marketPrice: { amount: 138, currency: "GAME_CREDIT" } },
    { date: "2026-07-26", referencePrice: null, marketPrice: { amount: 152, currency: "GAME_CREDIT" } },
    { date: "2026-07-27", referencePrice: { amount: 120, currency: "EUR" }, marketPrice: { amount: 144, currency: "GAME_CREDIT" } }
  ];
  return envelope({ skuId, range, points, referenceSource: "mtgjson-cardmarket", generatedAt: now });
}

test.describe("价格历史与市场曲线（I17F）", () => {
  test("市场指数双曲线渲染，默认 30d；切换 7d/全部会以 range 写入 URL 并重查", async ({ page }) => {
    const indexUrls: string[] = [];
    await page.route("**/v1/market/index/history*", async (route) => {
      const range = new URL(route.request().url()).searchParams.get("range");
      indexUrls.push(`range=${range}`);
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(indexHistoryPayload(range === "7d" || range === "30d" || range === "all" ? range : "30d")) });
    });
    await page.route("**/v1/market/quotes?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [quotedItem], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await stubPriceStatus(page, "fresh");
    await recoverPlayerSession(page);

    await page.goto("/market/history");
    await expect(page.getByRole("heading", { name: "价格历史与市场曲线" })).toBeVisible();
    // 默认 30d：首次查询以 range=30d 请求，URL 此时未携带 range（默认值不强制写入）。
    await expect(page.getByRole("img", { name: /市场指数双曲线，覆盖 3 个自然日/ })).toBeVisible();
    // 图例区分两条曲线：金色为外部参考指数，蓝色为游戏内市场指数。
    await expect(page.getByText("外部参考指数（EUR 分均值）")).toBeVisible();
    await expect(page.getByText("游戏内市场指数（游戏币均值）")).toBeVisible();
    expect(indexUrls.some((entry) => entry.startsWith("range=30d"))).toBe(true);

    // 切换 7 天：URL 写入 range=7d，并以新 range 重新查询。
    await page.getByRole("group", { name: "价格历史时间范围" }).getByRole("button", { name: "近 7 天" }).click();
    await expect(page).toHaveURL(/range=7d/);
    expect(indexUrls.some((entry) => entry.startsWith("range=7d"))).toBe(true);

    // 切换全部：URL 写入 range=all，并以新 range 重新查询。
    await page.getByRole("group", { name: "价格历史时间范围" }).getByRole("button", { name: "全部" }).click();
    await expect(page).toHaveURL(/range=all/);
    expect(indexUrls.some((entry) => entry.startsWith("range=all"))).toBe(true);
  });

  test("选中 SKU 渲染单卡双曲线、来源说明与降级表格；空历史不伪造价格", async ({ page }) => {
    await page.route("**/v1/market/index/history*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(indexHistoryPayload("30d")) }));
    await page.route("**/v1/market/quotes?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [quotedItem], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await page.route("**/v1/market/quotes/*/history*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(skuHistoryPayload("30d")) }));
    await stubPriceStatus(page, "fresh");
    await recoverPlayerSession(page);

    await page.goto("/market/history");
    await page.getByRole("button", { name: "查看历史" }).click();
    await expect(page).toHaveURL(new RegExp(`skuId=${skuId}`));
    await expect(page.getByRole("img", { name: /价格历史夹具卡 双曲线，覆盖 3 个自然日/ })).toBeVisible();
    await expect(page.getByText("MTGJSON / Cardmarket EUR").first()).toBeVisible();
    // 降级表格展示断开的日期点；用单卡特有日期锁定到 SKU 表格，避免命中指数表格。
    const skuTable = page.locator("table").filter({ hasText: "Cardmarket EUR 参考价" });
    await expect(skuTable).toBeVisible();
    await expect(skuTable.getByText("2026-07-26")).toBeVisible();
    await expect(skuTable.getByText("当日无快照")).toBeVisible();

    // 空历史：服务端返回空 points，页面展示空态而非空白或伪价格。skuId 仍保留在 URL 中。
    await page.route("**/v1/market/quotes/*/history*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ skuId, range: "30d", points: [], referenceSource: null, generatedAt: now })) }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "该 SKU 暂无历史快照" })).toBeVisible();
    await expect(page.getByRole("img", { name: /价格历史夹具卡 双曲线/ })).toHaveCount(0);
  });

  test("价格同步失败（stale）仍展示旧价、过期状态与免责声明，不渲染为空白或实时价格", async ({ page }) => {
    await page.route("**/v1/market/index/history*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(indexHistoryPayload("30d")) }));
    await page.route("**/v1/market/quotes?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await stubPriceStatus(page, "stale");
    await recoverPlayerSession(page);

    await page.goto("/market/history");
    await expect(page.getByText("价格同步失败时沿用最近成功快照；这不是实时 Cardmarket 价格。")).toBeVisible();
    await expect(page.getByText("同步失败，沿用旧快照")).toBeVisible();
    await expect(page.getByText("MTGJSON / Cardmarket EUR 每日参考快照")).toBeVisible();
    // stale 时指数历史仍来自服务端旧快照，图表区域渲染。
    await expect(page.getByRole("img", { name: /市场指数双曲线，覆盖 3 个自然日/ })).toBeVisible();
  });

  test("查询失败显示错误重试而非伪造数据；图表 img 对读屏可达（role + aria-label）", async ({ page }) => {
    await page.route("**/v1/market/index/history*", async (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "指数历史暂不可用" }, meta: { requestId: "i17f-fail" } }) }));
    await page.route("**/v1/market/quotes?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await stubPriceStatus(page, "fresh");
    await recoverPlayerSession(page);

    await page.goto("/market/history");
    await expect(page.getByRole("heading", { name: "市场指数历史读取失败" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
    // 失败时不渲染图表区域，绝不伪造价格。
    await expect(page.getByRole("img", { name: /市场指数双曲线/ })).toHaveCount(0);
    // 成功路径下图表 img 具备 role + 描述性 aria-label（在其它用例已覆盖可见性）。
  });
});

test.describe("价格历史窄屏（390 × 844）", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("窄屏展示指数双曲线、范围切换与降级表格不阻断", async ({ page }) => {
    await page.route("**/v1/market/index/history*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(indexHistoryPayload("30d")) }));
    await page.route("**/v1/market/quotes?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await stubPriceStatus(page, "fresh");
    await recoverPlayerSession(page);

    await page.goto("/market/history");
    await expect(page.getByRole("heading", { name: "价格历史与市场曲线" })).toBeVisible();
    await expect(page.getByRole("img", { name: /市场指数双曲线，覆盖 3 个自然日/ })).toBeVisible();
    await expect(page.locator("table").filter({ hasText: "外部参考指数" })).toBeVisible();
    await page.getByRole("group", { name: "价格历史时间范围" }).getByRole("button", { name: "近 7 天" }).click();
    await expect(page).toHaveURL(/range=7d/);
  });
});
