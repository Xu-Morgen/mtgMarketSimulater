import { expect, test, type Page } from "@playwright/test";

const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const now = "2026-08-05T08:00:00.000Z";
const userId = "10000000-0000-4000-8000-000000000340";
const skuA = "30000000-0000-4000-8000-000000000001";
const skuB = "30000000-0000-4000-8000-000000000002";

function envelope(data: unknown) {
  return { ok: true, data, meta: { requestId: "i34f-e2e" } };
}

async function session(page: Page) {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i34f-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          accessToken: "i34f-token",
          user: { id: userId, email: "i34f@example.test", displayName: "I34F 测试玩家", role: "player", createdAt: now }
        })
      )
    })
  );
  // I36F：价格历史页挂载时向服务端提交新手引导「看懂价格」浏览意图（view_event），
  // 这里 stub 返回成功，避免测试访问真实 API；不参与本 spec 的断言。
  await page.route("**/v1/onboarding/steps/view-price-history/view", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ onboarding: { ruleVersion: "onboarding/v3", steps: [], completedCount: 0, totalCount: 0, allCompleted: false, currentStepId: "view-price-history", reward: { status: "unavailable", amount: { amount: 500, currency: "GAME_CREDIT" }, claimedAt: null }, updatedAt: now } })
      )
    })
  );
}

const quotedA = {
  sku: { id: skuA, name: "行情测试卡A", setCode: "I34", setName: "I34F 测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare", imagePath: null },
  quote: {
    skuId: skuA,
    quoteVersion: "market/v1",
    referencePrice: { amount: 123, currency: "EUR" },
    marketPrice: { amount: 150, currency: "GAME_CREDIT" },
    npcBuyPrice: { amount: 135, currency: "GAME_CREDIT" },
    npcSellPrice: { amount: 165, currency: "GAME_CREDIT" },
    validUntil: now,
    source: "mtgjson-cardmarket",
    capturedAt: now,
    reasons: [
      { kind: "event", factorBasisPoints: 20_000, reason: "夏季冠军赛活动" },
      { kind: "bias", factorBasisPoints: 11_000, reason: "NPC 本周扫货 I34 系列" }
    ]
  },
  tradable: true,
  tradeDisabledReason: null
};

const heatDto = {
  intradayGainers: [
    { sku: { id: skuA, name: "行情测试卡A", setCode: "I34", setName: "I34F 测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare" }, changeBasisPoints: 2000, direction: "up", currentPrice: { amount: 150, currency: "GAME_CREDIT" }, basePrice: { amount: 125, currency: "GAME_CREDIT" } }
  ],
  intradayLosers: [
    { sku: { id: skuB, name: "行情测试卡B", setCode: "I34", setName: "I34F 测试系列", collectorNumber: "2", finish: "foil", rarity: "mythic" }, changeBasisPoints: -1000, direction: "down", currentPrice: { amount: 100, currency: "GAME_CREDIT" }, basePrice: { amount: 111, currency: "GAME_CREDIT" } }
  ],
  sevenDayGainers: [],
  sevenDayLosers: [],
  mostActive: [{ sku: { id: skuA, name: "行情测试卡A", setCode: "I34", setName: "I34F 测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare" }, quantity: 5, turnover: { amount: 750, currency: "GAME_CREDIT" } }],
  capturedAt: now
};

async function mockMarketPageCommon(page: Page) {
  await page.route("**/v1/market/quotes?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [quotedA], page: { total: 1, hasMore: false, nextCursor: null } })) })
  );
  await page.route("**/v1/market/index", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ referenceIndex: 123, gameIndex: 148, quotedSkus: 1, capturedAt: now })) })
  );
  await page.route("**/v1/prices/status", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "fresh" })) })
  );
  await page.route("**/v1/market/heat", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(heatDto)) })
  );
  await page.route("**/v1/market/announcements", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          items: [
            { type: "series_cycle", title: "系列周期：I34F 测试系列", scope: "set", setCode: "I34", setName: "I34F 测试系列", skuName: null, startsAt: now, endsAt: "2026-08-20T00:00:00.000Z", reason: "新系列倒计时" }
          ],
          capturedAt: now
        })
      )
    })
  );
  await page.route("**/v1/market/index/history*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ range: "7d", points: [{ date: "2026-08-03", referenceIndex: 100, gameIndex: 100 }, { date: "2026-08-04", referenceIndex: 105, gameIndex: 105 }, { date: "2026-08-05", referenceIndex: 98, gameIndex: 98 }], generatedAt: now })
      )
    })
  );
  await page.route("**/v1/market/quotes/*/history*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ skuId: skuA, range: "30d", points: [{ date: "2026-08-04", referencePrice: { amount: 123, currency: "EUR" }, marketPrice: { amount: 148, currency: "GAME_CREDIT" } }], referenceSource: "mtgjson-cardmarket", generatedAt: now })
      )
    })
  );
}

test("市场页行情屏：涨跌榜 ▲/▼、迷你走势条、公告区与叙事横幅，价格可跳转历史页", async ({ page }) => {
  await session(page);
  await mockMarketPageCommon(page);
  await page.goto("/market");
  await expect(page.getByRole("heading", { name: "市场", exact: true })).toBeVisible();
  // 价格提醒入口：侧栏导航链接（页内 intro 也有同名 text-button 链接，取导航内那个）。
  await expect(page.getByLabel("玩家导航").getByRole("link", { name: "价格提醒" })).toBeVisible();
  // 行情屏：涨跌榜方向与幅度只展示服务端聚合。
  await expect(page.getByRole("heading", { name: "行情屏" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "日内涨幅榜" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "日内跌幅榜" })).toBeVisible();
  await expect(page.getByText("▲ 20%").first()).toBeVisible();
  // 跌幅榜方向徽标：changeBasisPoints 为负，服务端渲染「▼ -10%」（负号来自百分比格式化）。
  await expect(page.getByText("▼ -10%").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "当日最活跃交易" })).toBeVisible();
  await expect(page.getByText("成交 5 张")).toBeVisible();
  // 迷你走势条：SVG 只读服务端指数历史点。
  const sparkline = page.getByRole("img", { name: /游戏内市场指数迷你走势/ });
  await expect(sparkline).toBeVisible();
  // 公告区：只展示标题/范围/区间，不含内部系数。
  await expect(page.getByRole("heading", { name: "市场公告" })).toBeVisible();
  await expect(page.getByText("系列周期：I34F 测试系列")).toBeVisible();
  await expect(page.getByRole("link", { name: "查看系列 I34 卡牌 →" })).toBeVisible();
  await expect(page.getByText("新系列倒计时")).toBeVisible();
  // 叙事横幅：只展示服务端 NPC 倾向原因文案。
  await expect(page.getByRole("heading", { name: "市场叙事" })).toBeVisible();
  await expect(page.getByText(/服务端 NPC 做市商倾向：NPC 本周扫货 I34 系列/)).toBeVisible();
  // 报价表价格列 ▲/▼ 徽标与可点击价格（行情榜与报价表各有一个 150 游戏币链接，取报价表内嵌）。
  await expect(page.getByText("▲ 20%").nth(1)).toBeVisible();
  const priceLink = page.getByRole("link", { name: "150 游戏币" }).nth(1);
  await expect(priceLink).toBeVisible();
  await priceLink.click();
  await expect(page).toHaveURL(new RegExp(`/market/history\\?.*skuId=${skuA}`));
  await expect(page.getByRole("heading", { name: "价格历史与市场曲线" })).toBeVisible();
});

test("价格提醒页：列表/搜索添加二次确认、删除与启停只投递一次，提醒未读与已读", async ({ page }) => {
  await session(page);
  await page.route("**/v1/market/quotes?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [quotedA], page: { total: 1, hasMore: false, nextCursor: null } })) })
  );
  await page.route("**/v1/catalog/cards/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          sku: {
            id: skuA, printingId: `printing-${skuA}`, scryfallId: `scryfall-${skuA}`, name: "行情测试卡A",
            setCode: "I34", setName: "I34F 测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare",
            legalities: {}, manaCost: null, colors: [], colorIdentity: [], typeLine: "Creature", power: "1", toughness: "1",
            image: { path: null, sourceUrl: null, status: "missing", cachedAt: null }, source: "scryfall", sourceReference: null,
            isManualException: false, tradable: true, oracleText: null, artist: null, releasedAt: null
          }
        })
      )
    })
  );
  let watchlistReads = 0;
  await page.route("**/v1/watchlist", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    watchlistReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          items: [
            { id: "watch-1", skuId: skuA, targetType: "game_price", direction: "at_or_below", targetAmount: 100, enabled: true, createdAt: now, updatedAt: now }
          ],
          limits: { maxItemsPerUser: 50 }
        })
      )
    });
  });
  await page.route("**/v1/watchlist/alerts", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          items: [
            { id: "alert-1", watchlistItemId: "watch-1", skuId: skuA, targetType: "game_price", direction: "at_or_below", targetAmount: 100, triggeredPrice: 95, triggeredAt: now, read: false }
          ],
          unreadCount: 1
        })
      )
    })
  );
  let upsertCalls = 0;
  const upsertKeys: string[] = [];
  await page.route("**/v1/watchlist", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    upsertCalls += 1;
    upsertKeys.push(route.request().headers()["idempotency-key"] ?? "");
    const body = route.request().postDataJSON() as { skuId: string; enabled: boolean };
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          envelope({ id: `watch-${upsertCalls}`, skuId: body.skuId, targetType: "game_price", direction: "at_or_below", targetAmount: 100, enabled: body.enabled, createdAt: now, updatedAt: now })
        )
      });
    })();
  });
  let deleteCalls = 0;
  let deleteKey = "";
  await page.route("**/v1/watchlist/**", (route) => {
    if (route.request().method() !== "DELETE") return route.fallback();
    deleteCalls += 1;
    deleteKey = route.request().headers()["idempotency-key"] ?? "";
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ removed: true })) });
    })();
  });
  let readCalls = 0;
  await page.route("**/v1/watchlist/alerts/*/read", (route) => {
    readCalls += 1;
    return (async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope({ alertId: "alert-1", read: true })) });
    })();
  });

  await page.goto("/watchlist");
  await expect(page.getByRole("heading", { name: "价格提醒", exact: true })).toBeVisible();
  // 已触达提醒：未读数与触发价均来自服务端。
  await expect(page.getByText("未读 1")).toBeVisible();
  await expect(page.getByText("行情测试卡A").first()).toBeVisible();
  await expect(page.getByText(/触发价 95 游戏币/)).toBeVisible();
  // 列表：目标价/方向/启停只展示服务端保存值（列表方向徽标渲染为「≤ 跌到或低于」）。
  await expect(page.getByText("≤ 跌到或低于").first()).toBeVisible();
  await expect(page.getByText("100 游戏币").first()).toBeVisible();
  await expect(page.getByText("启用中").first()).toBeVisible();
  await expect(page.getByText("1 / 50").first()).toBeVisible();

  // 搜索卡牌并二次确认添加提醒：POST 只投递一次且带幂等键。
  await page.getByLabel("搜索卡牌").fill("行情测试卡A");
  await page.getByRole("button", { name: "搜索", exact: true }).click();
  await expect(page.getByRole("button", { name: /行情测试卡A/ })).toBeVisible();
  await page.getByRole("button", { name: /行情测试卡A/ }).click();
  await expect(page.getByLabel("目标价").first()).toBeVisible();
  const addConfirm = page.getByRole("button", { name: "确认添加提醒" });
  await addConfirm.click();
  await expect(page.getByRole("heading", { name: "确认添加价格提醒" })).toBeVisible();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click({ force: true });
  await expect(page.getByText("已选择：").first()).not.toBeVisible();
  expect(upsertCalls).toBe(1);
  expect(upsertKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);

  // 启停：更新（POST）只投递一次并复用幂等键语义。
  await page.getByRole("button", { name: "停用", exact: true }).click();
  await expect(page.getByRole("heading", { name: "确认停用价格提醒" })).toBeVisible();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByRole("heading", { name: "确认停用价格提醒" })).toHaveCount(0);
  expect(upsertCalls).toBe(2);

  // 删除：二次确认 + DELETE 只投递一次。
  await page.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.getByRole("heading", { name: "确认删除价格提醒" })).toBeVisible();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await page.getByRole("button", { name: "确认", exact: true }).click({ force: true });
  expect(deleteCalls).toBe(1);
  expect(deleteKey).toMatch(/^[0-9a-f-]{36}$/i);

  // 标记提醒已读：POST 只投递一次。
  await page.getByRole("button", { name: "标记已读" }).click();
  await page.getByRole("button", { name: "标记已读" }).click({ force: true });
  expect(readCalls).toBe(1);
  expect(watchlistReads).toBeGreaterThanOrEqual(1);
});

test("我的委托：订单簿盘口深度展示累计量、中间价与价差", async ({ page }) => {
  await session(page);
  const skuId = skuA;
  await page.route("**/v1/orders?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          items: [
            { id: "order-1", skuId, side: "buy", status: "open", originalQuantity: 3, remainingQuantity: 3, limitPrice: { amount: 100, currency: "GAME_CREDIT" }, fees: [], reservedFunds: { amount: 300, currency: "GAME_CREDIT" }, reservedInventoryQuantity: 0, fulfillmentDeposit: null, expiresAt: "2026-08-06T08:00:00.000Z", version: 1, createdAt: now, updatedAt: now, ruleVersion: "order/v1" }
          ],
          page: { total: 1, hasMore: false, nextCursor: null }
        })
      )
    })
  );
  await page.route("**/v1/orders/trades?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) })
  );
  await page.route(`**/v1/orders/book/${skuId}`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          book: {
            skuId,
            bids: [
              { limitPrice: { amount: 100, currency: "GAME_CREDIT" }, remainingQuantity: 3, cumulativeQuantity: 3, orderCount: 1 },
              { limitPrice: { amount: 90, currency: "GAME_CREDIT" }, remainingQuantity: 2, cumulativeQuantity: 5, orderCount: 1 }
            ],
            asks: [{ limitPrice: { amount: 120, currency: "GAME_CREDIT" }, remainingQuantity: 4, cumulativeQuantity: 4, orderCount: 2 }],
            midPrice: { amount: 110, currency: "GAME_CREDIT" },
            spread: { amount: 20, currency: "GAME_CREDIT" },
            capturedAt: now
          }
        })
      )
    })
  );
  await page.goto("/orders");
  await expect(page.getByRole("heading", { name: "我的委托" })).toBeVisible();
  // 盘口深度：中间价/价差条由服务端给出，不推导。
  await expect(page.getByText(/中间价 110 游戏币 · 价差 20 游戏币/)).toBeVisible();
  // 逐档累计量列。
  await expect(page.getByRole("table").first().getByRole("columnheader", { name: "累计量" })).toBeVisible();
  await expect(page.getByRole("table").first().getByText("5", { exact: true })).toBeVisible();
  await expect(page.getByText("买单（价格降序）")).toBeVisible();
  await expect(page.getByText("卖单（价格升序）")).toBeVisible();
});

test("库存页按筛选批量卖出：二次确认只投递一次并展示服务端汇总", async ({ page }) => {
  await session(page);
  await page.route("**/v1/inventory?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          items: [
            {
              skuId: skuA, quantity: 4, availableQuantity: 3, orderLockedQuantity: 1, tournamentLockedQuantity: 0,
              averageCost: { amount: 120, currency: "GAME_CREDIT" }, marketUnitPrice: { amount: 148, currency: "GAME_CREDIT" },
              marketValue: { amount: 592, currency: "GAME_CREDIT" }, unrealizedProfitLoss: { amount: 100, currency: "GAME_CREDIT" },
              updatedAt: now,
              sku: { id: skuA, name: "行情测试卡A", setCode: "I34", setName: "I34F 测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare", imagePath: null, tradable: true }
            },
            {
              skuId: skuB, quantity: 2, availableQuantity: 0, orderLockedQuantity: 2, tournamentLockedQuantity: 0,
              averageCost: { amount: 90, currency: "GAME_CREDIT" }, marketUnitPrice: null, marketValue: null, unrealizedProfitLoss: null,
              updatedAt: now,
              sku: { id: skuB, name: "行情测试卡B", setCode: "I34", setName: "I34F 测试系列", collectorNumber: "2", finish: "foil", rarity: "mythic", imagePath: null, tradable: true }
            }
          ],
          page: { total: 2, hasMore: false, nextCursor: null }
        })
      )
    })
  );
  await page.route("**/v1/prices/status", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "fresh" })) })
  );
  let batchCalls = 0;
  let batchKey = "";
  await page.route("**/v1/npc-trades/sell/batch", async (route) => {
    batchCalls += 1;
    batchKey = route.request().headers()["idempotency-key"] ?? "";
    const body = route.request().postDataJSON() as { skuIds: string[] };
    expect(body.skuIds).toEqual([skuA]);
    await new Promise((resolve) => setTimeout(resolve, 120));
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          result: {
            soldItems: [{ skuId: skuA, quantity: 3, unitPrice: { amount: 148, currency: "GAME_CREDIT" }, unitFee: { amount: 7, currency: "GAME_CREDIT" }, total: { amount: 444, currency: "GAME_CREDIT" }, fee: { amount: 21, currency: "GAME_CREDIT" } }],
            skippedItems: [{ skuId: skuB, reason: "no_available_quantity" }],
            cardCount: 3,
            income: { amount: 444, currency: "GAME_CREDIT" },
            fee: { amount: 21, currency: "GAME_CREDIT" }
          }
        })
      )
    });
  });
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "我的库存" })).toBeVisible();
  // 全站价格可点击：持仓卡名与现价跳转该 SKU 价格历史页（携带 skuId）。
  await expect(page.getByRole("link", { name: "行情测试卡A" })).toHaveAttribute("href", new RegExp(`/market/history\\?skuId=${skuA}`));
  await expect(page.getByRole("link", { name: "148 游戏币 / 张" })).toHaveAttribute("href", new RegExp(`/market/history\\?skuId=${skuA}`));
  // 按筛选批量卖出：只提交有可用量的 SKU，二次确认只投递一次。
  await page.getByRole("button", { name: "批量卖出当前筛选" }).click();
  await expect(page.getByRole("heading", { name: "批量卖出当前筛选" })).toBeVisible();
  await expect(page.getByText("1 个 SKU")).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认批量卖出" });
  // 二次确认的重复点击只投递一次：单次 dblclick 在一次可操作性检查后派发两次点击，
  // 按钮随后禁用改文案也不会再次解析 locator；配合弹窗内同步 confirmationLock 验证不重复投递。
  await confirm.dblclick();
  await expect(page.getByRole("heading", { name: "按筛选批量卖出已完成" })).toBeVisible();
  await expect(page.getByText(/服务端共卖出 3 张/)).toBeVisible();
  await expect(page.getByText(/实际收入 444 游戏币/)).toBeVisible();
  // 跳过明细：服务端 reason=no_available_quantity 渲染为中文原因文案（浏览器不自行翻译）。
  await expect(page.getByText(/可用库存为 0（全部被订单\/比赛锁定）/)).toBeVisible();
  expect(batchCalls).toBe(1);
  expect(batchKey).toMatch(/^[0-9a-f-]{36}$/i);
});
