import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-27T08:00:00.000Z";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const skuId = "30000000-0000-4000-8000-000000000161";
const quoteId = "60000000-0000-4000-8000-000000000161";
const userId = "10000000-0000-4000-8000-000000000181";
const orderId = "70000000-0000-4000-8000-000000000181";

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i18f-e2e" } }; }
function failure(code: string, message: string) { return { ok: false, error: { code, message }, meta: { requestId: "i18f-failure" } }; }

const marketItem = {
  sku: { id: skuId, name: "委托夹具卡", setCode: "ORD", setName: "订单测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare" },
  quote: { skuId, quoteVersion: "market/v1", referencePrice: { amount: 200, currency: "EUR" }, marketPrice: { amount: 200, currency: "GAME_CREDIT" }, npcBuyPrice: { amount: 170, currency: "GAME_CREDIT" }, npcSellPrice: { amount: 250, currency: "GAME_CREDIT" }, validUntil: now, source: "mtgjson-cardmarket", capturedAt: now, reasons: [] },
  tradable: true,
  tradeDisabledReason: null
};

function buyPreview(quantity: number, unavailableReason: "archive_required" | "insufficient_balance" | "insufficient_inventory" | "trade_limit_reached" | null = null) {
  // order_fee_bps 200 → 单位 4；fulfillment_deposit_bps 1000 → 单位 20；marketPrice 200。
  return {
    skuId, side: "buy", quantity, quoteId, quoteVersion: "market/v1",
    fees: [{ kind: "order_fee", amount: { amount: quantity * 4, currency: "GAME_CREDIT" } }, { kind: "fulfillment_deposit", amount: { amount: quantity * 20, currency: "GAME_CREDIT" } }],
    reservedFunds: { amount: quantity * 204, currency: "GAME_CREDIT" },
    estimatedAmount: { amount: quantity * 200, currency: "GAME_CREDIT" },
    limitBand: { marketPrice: { amount: 200, currency: "GAME_CREDIT" }, min: { amount: 100, currency: "GAME_CREDIT" }, max: { amount: 300, currency: "GAME_CREDIT" }, limitPriceBandBasisPoints: 5000 },
    previewVersion: "a".repeat(64), validUntil: "2099-01-01T00:00:00.000Z",
    limit: { maxQuantityPerOrder: 20, maxQuantityPerUserSkuDay: 100, remainingQuantityToday: 100, ttlSeconds: 86400 },
    canPlace: unavailableReason === null, unavailableReason
  };
}

function sellPreview(quantity: number, unavailableReason: "archive_required" | "insufficient_balance" | "insufficient_inventory" | "trade_limit_reached" | null = null) {
  return {
    skuId, side: "sell", quantity, availableQuantity: 3, quoteId, quoteVersion: "market/v1",
    fees: [{ kind: "order_fee", amount: { amount: quantity * 4, currency: "GAME_CREDIT" } }, { kind: "fulfillment_deposit", amount: { amount: quantity * 20, currency: "GAME_CREDIT" } }],
    reservedFunds: { amount: quantity * 20, currency: "GAME_CREDIT" },
    estimatedAmount: { amount: quantity * 200, currency: "GAME_CREDIT" },
    limitBand: { marketPrice: { amount: 200, currency: "GAME_CREDIT" }, min: { amount: 100, currency: "GAME_CREDIT" }, max: { amount: 300, currency: "GAME_CREDIT" }, limitPriceBandBasisPoints: 5000 },
    previewVersion: "b".repeat(64), validUntil: "2099-01-01T00:00:00.000Z",
    limit: { maxQuantityPerOrder: 20, maxQuantityPerUserSkuDay: 100, remainingQuantityToday: 100, ttlSeconds: 86400 },
    canPlace: unavailableReason === null, unavailableReason
  };
}

function order(side: "buy" | "sell", quantity: number, limitPrice: number, status: "open" | "cancelled" | "partially_filled" = "open", version = 1): Record<string, unknown> {
  return {
    id: orderId, userId, skuId, side, status, originalQuantity: quantity, remainingQuantity: quantity,
    limitPrice: { amount: limitPrice, currency: "GAME_CREDIT" },
    fees: [{ kind: "order_fee", amount: { amount: quantity * 4, currency: "GAME_CREDIT" } }, { kind: "fulfillment_deposit", amount: { amount: quantity * 20, currency: "GAME_CREDIT" } }],
    reservedFunds: side === "buy" ? { amount: quantity * 204, currency: "GAME_CREDIT" } : { amount: quantity * 20, currency: "GAME_CREDIT" },
    reservedInventoryQuantity: side === "sell" ? quantity : 0,
    fulfillmentDeposit: side === "sell" ? { amount: quantity * 20, currency: "GAME_CREDIT" } : null,
    expiresAt: "2099-01-01T00:00:00.000Z", version, createdAt: now, updatedAt: now
  };
}

async function recoverPlayerSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "orders-e2e-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "orders-e2e-token", user: { id: userId, email: "orders-e2e@example.test", displayName: "委托测试玩家", role: "player", createdAt: now } })) }));
}

async function mockMarket(page: Page): Promise<void> {
  await page.route("**/v1/market/quotes?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [marketItem], page: { total: 1, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/market/index", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ referenceIndex: 120, gameIndex: 144, quotedSkus: 1, capturedAt: now })) }));
  await page.route("**/v1/prices/status", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "fresh", disclaimer: "MTGJSON / Cardmarket EUR 每日参考快照。" })) }));
}

async function mockInventory(page: Page): Promise<void> {
  await page.route("**/v1/inventory?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{
    skuId, quantity: 5, availableQuantity: 3, orderLockedQuantity: 2, tournamentLockedQuantity: 0,
    averageCost: { amount: 120, currency: "GAME_CREDIT" }, marketUnitPrice: { amount: 150, currency: "GAME_CREDIT" }, marketValue: { amount: 750, currency: "GAME_CREDIT" }, unrealizedProfitLoss: { amount: 150, currency: "GAME_CREDIT" }, marketValueUnavailableReason: null, updatedAt: now,
    sku: { id: skuId, name: "委托夹具卡", setCode: "ORD", setName: "订单测试系列", collectorNumber: "1", finish: "nonfoil", imagePath: null, tradable: true }
  }], page: { total: 1, hasMore: false, nextCursor: null } })) }));
}

test.describe("P2P 委托创建（I18F）", () => {
  test("买单创建只回传服务端预览版本与玩家限价，双击只发一个 POST", async ({ page }) => {
    let postCalls = 0; const keys: string[] = [];
    await mockMarket(page);
    await page.route(`**/v1/orders/buy/${skuId}/preview?*`, async (route) => {
      const quantity = Number(new URL(route.request().url()).searchParams.get("quantity"));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: buyPreview(quantity) })) });
    });
    await page.route(`**/v1/orders/buy/${skuId}`, async (route) => {
      postCalls += 1; keys.push(route.request().headers()["idempotency-key"] ?? "");
      expect(route.request().postDataJSON()).toEqual({ quoteId, quoteVersion: "market/v1", previewVersion: "a".repeat(64), quantity: 2, limitPrice: 200 });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ order: order("buy", 2, 200) })) });
    });
    await recoverPlayerSession(page);
    await page.goto("/market");
    await page.getByRole("button", { name: "挂买单" }).click();
    await expect(page.getByRole("heading", { name: "挂委托" })).toBeVisible();
    await page.getByLabel("委托数量").fill("2");
    await page.getByRole("button", { name: "获取服务端预览" }).click();
    await expect(page.getByText("限价带：100 游戏币 – 300 游戏币")).toBeVisible();
    await expect(page.getByText("本次预占：买单资金 408 游戏币")).toBeVisible();
    // 默认限价被填入服务端锚点 200。
    await expect(page.getByLabel("委托限价")).toHaveValue("200");
    const confirm = page.getByRole("button", { name: "确认挂买单" });
    await confirm.dblclick();
    await expect(page.getByRole("heading", { name: "挂单已创建" })).toBeVisible();
    await expect(page.getByText("服务端已创建买单（限价 200 游戏币，数量 2 张，状态 open）")).toBeVisible();
    expect(postCalls).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("限价越界即时提示，余额不足禁用确认且不发起请求", async ({ page }) => {
    let postCalls = 0;
    await mockMarket(page);
    await page.route(`**/v1/orders/buy/${skuId}/preview?*`, async (route) => {
      const quantity = Number(new URL(route.request().url()).searchParams.get("quantity"));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: buyPreview(quantity, "insufficient_balance") })) });
    });
    await page.route(`**/v1/orders/buy/${skuId}`, async (route) => { postCalls += 1; await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ order: order("buy", 1, 200) })) }); });
    await recoverPlayerSession(page);
    await page.goto("/market");
    await page.getByRole("button", { name: "挂买单" }).click();
    await page.getByLabel("委托数量").fill("1");
    await page.getByRole("button", { name: "获取服务端预览" }).click();
    // 余额不足 → 确认禁用、显示服务端原因，不发请求。
    await expect(page.getByText("当前余额不足以预占买单资金，请减少数量或补充游戏币。")).toBeVisible();
    await expect(page.getByRole("button", { name: "确认挂买单" })).toBeDisabled();
    // 限价越界 → 即时提示但不提交（真正的边界由服务端兜底）。
    await page.getByLabel("委托限价").fill("301");
    await page.getByLabel("委托限价").blur();
    await expect(page.getByText("限价必须在服务端限价带 100 游戏币 至 300 游戏币 之间")).toBeVisible();
    expect(postCalls).toBe(0);
  });

  test("报价过期返回 VERSION_STALE，重新预览后用新幂等键成交", async ({ page }) => {
    let postCalls = 0; const keys: string[] = [];
    await mockMarket(page);
    await page.route(`**/v1/orders/buy/${skuId}/preview?*`, async (route) => {
      const quantity = Number(new URL(route.request().url()).searchParams.get("quantity"));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: buyPreview(quantity) })) });
    });
    await page.route(`**/v1/orders/buy/${skuId}`, async (route) => {
      postCalls += 1; keys.push(route.request().headers()["idempotency-key"] ?? "");
      if (postCalls === 1) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(failure("VERSION_STALE", "报价已过期，请重新获取服务端预览")) });
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ order: order("buy", 1, 200) })) });
    });
    await recoverPlayerSession(page);
    await page.goto("/market");
    await page.getByRole("button", { name: "挂买单" }).click();
    await page.getByLabel("委托数量").fill("1");
    await page.getByRole("button", { name: "获取服务端预览" }).click();
    await page.getByRole("button", { name: "确认挂买单" }).click();
    await expect(page.getByText("报价已过期，请重新获取服务端预览")).toBeVisible();
    await page.getByRole("button", { name: "重新预览" }).click();
    await page.getByRole("button", { name: "确认挂买单" }).click();
    await expect(page.getByRole("heading", { name: "挂单已创建" })).toBeVisible();
    expect(postCalls).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});

test.describe("我的委托与撤单（I18F）", () => {
  test("挂卖单后出现在我的委托，撤单释放并刷新；重复撤单提示刷新", async ({ page }) => {
    await mockInventory(page);
    let currentOrders: Record<string, unknown>[] = [];
    let cancelCalls = 0;
    await page.route(`**/v1/orders/sell/${skuId}/preview?*`, async (route) => {
      const quantity = Number(new URL(route.request().url()).searchParams.get("quantity"));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: sellPreview(quantity) })) });
    });
    await page.route(`**/v1/orders/sell/${skuId}`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      currentOrders = [order("sell", 2, 200)];
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ order: order("sell", 2, 200) })) });
    });
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: currentOrders, page: { total: currentOrders.length, hasMore: false, nextCursor: null } })) }));
    await page.route(`**/v1/orders/${orderId}/cancel`, async (route) => {
      cancelCalls += 1;
      if (cancelCalls === 1) {
        currentOrders = [order("sell", 2, 200, "cancelled", 2)];
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope({ order: order("sell", 2, 200, "cancelled", 2) })) });
      } else {
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(failure("RESOURCE_CONFLICT", "委托状态已变化，请刷新后重试")) });
      }
    });
    await recoverPlayerSession(page);
    await page.goto("/inventory");
    await page.getByRole("button", { name: "挂卖单" }).click();
    await page.getByLabel("委托数量").fill("2");
    await page.getByRole("button", { name: "获取服务端预览" }).click();
    await expect(page.getByText("本次预占：履约保证金 40 游戏币")).toBeVisible();
    await page.getByRole("button", { name: "确认挂卖单" }).click();
    await expect(page.getByRole("heading", { name: "挂单已创建" })).toBeVisible();

    // 我的委托：导航可见、列表含新建卖单。订单页只展示服务端 skuId 与字段，不含卡名。
    await page.getByRole("link", { name: "我的委托" }).click();
    await expect(page).toHaveURL(/\/orders/);
    await expect(page.getByRole("heading", { name: "我的委托" })).toBeVisible();
    await expect(page.locator("table").getByText("卖单")).toBeVisible();
    await expect(page.locator("table").getByText("200 游戏币")).toBeVisible();

    // 撤单：二次确认 → 释放库存与保证金，状态从“挂单中”变为“已撤单”。
    await page.getByRole("button", { name: "撤单" }).click();
    await expect(page.getByRole("heading", { name: "确认撤单" })).toBeVisible();
    await page.getByRole("button", { name: "确认" }).click();
    await expect(page.getByRole("heading", { name: "撤单已完成" })).toBeVisible();
    await expect(page.getByText("解锁库存 2 张、释放履约保证金 40 游戏币")).toBeVisible();
    // 撤单成功后列表刷新：状态变为已撤单，操作列不再有撤单按钮。
    await expect(page.locator("table").getByText("已撤单")).toBeVisible();
    await expect(page.locator("table").getByText("不可撤单")).toBeVisible();
    await expect(page.locator("table").getByRole("button", { name: "撤单" })).toHaveCount(0);
    expect(cancelCalls).toBe(1);
  });

  test("状态/方向筛选写入 URL 并重查；空委托显示空态", async ({ page }) => {
    const listUrls: string[] = [];
    let payload: { items: unknown[]; page: { total: number; hasMore: boolean; nextCursor: null } } = { items: [order("buy", 2, 200)], page: { total: 1, hasMore: false, nextCursor: null } };
    await page.route("**/v1/orders?*", async (route) => {
      listUrls.push(new URL(route.request().url()).searchParams.toString());
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(payload)) });
    });
    await recoverPlayerSession(page);
    await page.goto("/orders");
    // 订单页表格内存在买单 Tag（区别于筛选下拉的 option）。
    await expect(page.locator("table").getByText("买单")).toBeVisible();
    // 方向筛选写 URL。
    await page.getByLabel("委托方向筛选").selectOption("sell");
    await expect(page).toHaveURL(/side=sell/);
    expect(listUrls.some((entry) => entry.includes("side=sell"))).toBe(true);
    // 状态筛选写 URL。
    await page.getByLabel("委托状态筛选").selectOption("open");
    await expect(page).toHaveURL(/status=open/);
    expect(listUrls.some((entry) => entry.includes("status=open"))).toBe(true);
    // 空委托显示空态而非伪造数据。
    payload = { items: [], page: { total: 0, hasMore: false, nextCursor: null } };
    await page.reload();
    await expect(page.getByRole("heading", { name: "没有委托记录" })).toBeVisible();
  });

  test("查询失败显示错误重试而非伪造委托", async ({ page }) => {
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "我的委托暂不可用" }, meta: { requestId: "i18f-fail" } }) }));
    await recoverPlayerSession(page);
    await page.goto("/orders");
    await expect(page.getByRole("heading", { name: "我的委托加载失败" })).toBeVisible();
    await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  });
});

test.describe("P2P 委托窄屏（390 × 844）", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("窄屏挂买单、我的委托与撤单流程不阻断", async ({ page }) => {
    await mockMarket(page);
    await page.route(`**/v1/orders/buy/${skuId}/preview?*`, async (route) => {
      const quantity = Number(new URL(route.request().url()).searchParams.get("quantity"));
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: buyPreview(quantity) })) });
    });
    await page.route(`**/v1/orders/buy/${skuId}`, async (route) => route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ order: order("buy", 1, 200) })) }));
    await recoverPlayerSession(page);
    await page.goto("/market");
    await page.getByRole("button", { name: "挂买单" }).click();
    await page.getByLabel("委托数量").fill("1");
    await page.getByRole("button", { name: "获取服务端预览" }).click();
    await page.getByRole("button", { name: "确认挂买单" }).click();
    await expect(page.getByRole("heading", { name: "挂单已创建" })).toBeVisible();
    await page.getByRole("link", { name: "我的委托" }).click();
    await expect(page.getByRole("heading", { name: "我的委托" })).toBeVisible();
  });
});

test.describe("P2P 订单簿与撮合状态（I19F）", () => {
  const buyerUserId = "10000000-0000-4000-8000-0000000001b1";
  const sellerUserId = "10000000-0000-4000-8000-0000000001b2";

  async function mockOrderBook(page: Page, bids: Array<{ price: number; qty: number; orders: number }>, asks: Array<{ price: number; qty: number; orders: number }>) {
    await page.route(`**/v1/orders/book/${skuId}`, async (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ book: { skuId, bids: bids.map((row) => ({ limitPrice: { amount: row.price, currency: "GAME_CREDIT" }, remainingQuantity: row.qty, orderCount: row.orders })), asks: asks.map((row) => ({ limitPrice: { amount: row.price, currency: "GAME_CREDIT" }, remainingQuantity: row.qty, orderCount: row.orders })), capturedAt: now } }))
    }));
  }

  async function mockArchive(page: Page, userId: string, frozenAmount = 408) {
    await page.route("**/v1/archive", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ archive: { id: "archive-1", userId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now, balance: { total: { amount: 10000, currency: "GAME_CREDIT" }, available: { amount: 10000 - frozenAmount, currency: "GAME_CREDIT" }, frozen: { amount: frozenAmount, currency: "GAME_CREDIT" }, updatedAt: now } } })) }));
    await page.route("**/v1/ledger?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  }

  /** 为指定会话恢复玩家身份并按 userId 返回该玩家的成交视角。 */
  async function recoverSessionAs(page: Page, userId: string, accessToken: string) {
    await page.context().addCookies([{ name: "mtg_csrf", value: `i19f-${userId}`, url: webBaseUrl }]);
    await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken, user: { id: userId, email: `i19f-${userId}@example.test`, displayName: userId === buyerUserId ? "买方玩家" : "卖方玩家", role: "player", createdAt: now } })) }));
  }

  /** 买方视角成交：role=buyer、待履约资金、无待履约库存；脱敏对手身份。 */
  function buyerTrade(quantity = 2) {
    return {
      id: "trade-buyer-1", skuId, role: "buyer", myOrderId: "order-buyer-1",
      quantity, executionPrice: { amount: 200, currency: "GAME_CREDIT" },
      fee: { amount: quantity * 4, currency: "GAME_CREDIT" },
      pendingFunds: { amount: quantity * 204, currency: "GAME_CREDIT" },
      pendingInventoryQuantity: null, ruleVersion: "order-matching/v1", status: "matched_pending_fulfillment",
      fulfillmentDeadline: "2026-07-29T08:00:00.000Z", createdAt: now, updatedAt: now
    };
  }
  /** 卖方视角成交：role=seller、待履约资金=保证金、待履约库存=已成交数量。 */
  function sellerTrade(quantity = 2) {
    return {
      id: "trade-seller-1", skuId, role: "seller", myOrderId: "order-seller-1",
      quantity, executionPrice: { amount: 200, currency: "GAME_CREDIT" },
      fee: { amount: quantity * 4, currency: "GAME_CREDIT" },
      pendingFunds: { amount: quantity * 20, currency: "GAME_CREDIT" },
      pendingInventoryQuantity: quantity, ruleVersion: "order-matching/v1", status: "matched_pending_fulfillment",
      fulfillmentDeadline: "2026-07-29T08:00:00.000Z", createdAt: now, updatedAt: now
    };
  }

  test("部分成交后双方订单簿一致、各自成交角色与待履约资产正确且脱敏对手", async ({ browser }) => {
    const buyerCtx = await browser.newContext();
    const sellerCtx = await browser.newContext();
    const buyerPage = await buyerCtx.newPage();
    const sellerPage = await sellerCtx.newPage();

    await mockMarket(buyerPage);
    await mockArchive(buyerPage, buyerUserId, 408);
    await mockOrderBook(buyerPage, [{ price: 210, qty: 2, orders: 1 }], [{ price: 220, qty: 3, orders: 1 }]);
    await buyerPage.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await buyerPage.route("**/v1/orders/trades?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [buyerTrade(2)], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await recoverSessionAs(buyerPage, buyerUserId, "buyer-token-i19f");

    await mockMarket(sellerPage);
    await mockArchive(sellerPage, sellerUserId, 40);
    await mockOrderBook(sellerPage, [{ price: 210, qty: 2, orders: 1 }], [{ price: 220, qty: 3, orders: 1 }]);
    await sellerPage.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await sellerPage.route("**/v1/orders/trades?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [sellerTrade(2)], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await recoverSessionAs(sellerPage, sellerUserId, "seller-token-i19f");

    // 买方：订单簿、成交角色与待履约资产。
    await buyerPage.goto("/orders");
    await expect(buyerPage.getByRole("heading", { name: "双边订单簿" })).toBeVisible();
    await expect(buyerPage.locator("text=210 游戏币").first()).toBeVisible();
    await expect(buyerPage.locator("text=220 游戏币").first()).toBeVisible();
    await expect(buyerPage.getByText("9,592 游戏币").first()).toBeVisible();
    await buyerPage.getByRole("heading", { name: "我的成交与待履约资产" }).scrollIntoViewIfNeeded();
    await expect(buyerPage.locator("table").getByText("买方")).toBeVisible();
    await expect(buyerPage.locator("table").getByText("408 游戏币")).toBeVisible();
    await expect(buyerPage.getByText("待履约资金 408 游戏币")).toBeVisible();

    // 卖方：成交角色为卖方、待履约资金为保证金、待履约库存为成交数量。
    await sellerPage.goto("/orders");
    await sellerPage.getByRole("heading", { name: "我的成交与待履约资产" }).scrollIntoViewIfNeeded();
    await expect(sellerPage.locator("table").getByText("卖方")).toBeVisible();
    await expect(sellerPage.locator("table").getByText("40 游戏币")).toBeVisible();
    await expect(sellerPage.getByText("待履约库存 2 张")).toBeVisible();

    await buyerCtx.close();
    await sellerCtx.close();
  });

  test("成交查询失败时提示数据可能过期，恢复后只接受服务端最新状态", async ({ page }) => {
    let failing = true;
    await mockMarket(page);
    await mockArchive(page, userId);
    await mockOrderBook(page, [{ price: 210, qty: 2, orders: 1 }], []);
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await page.route("**/v1/orders/trades?*", async (route) => {
      if (failing) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "成交暂不可用" }, meta: { requestId: "i19f-fail" } }) });
      await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [buyerTrade(1)], page: { total: 1, hasMore: false, nextCursor: null } })) });
    });
    await recoverSessionAs(page, userId, "buyer-token-i19f");
    await page.goto("/orders");
    await expect(page.getByText("成交数据可能过期，连接失败，正在重试")).toBeVisible();
    // 恢复后点击立即刷新；页面只展示服务端最新成交，不伪造空态或最新状态。
    failing = false;
    await page.getByRole("button", { name: "立即刷新" }).click();
    await expect(page.locator("table").getByText("买方")).toBeVisible();
    await expect(page.locator("table").getByText("204 游戏币")).toBeVisible();
  });

  test("空成交显示空态而非伪造数据", async ({ page }) => {
    await mockMarket(page);
    await mockArchive(page, userId, 0);
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await page.route("**/v1/orders/trades?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await recoverSessionAs(page, userId, "buyer-token-i19f");
    await page.goto("/orders");
    await expect(page.getByRole("heading", { name: "没有成交记录" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "尚未选择订单簿 SKU" })).toBeVisible();
  });
});

test.describe("P2P 订单簿与撮合状态窄屏（390 × 844）", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("窄屏订单簿、成交与待履约摘要不阻断", async ({ page }) => {
    await mockMarket(page);
    const sellerUserIdNarrow = "10000000-0000-4000-8000-0000000001b3";
    await page.route("**/v1/archive", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ archive: { id: "archive-1", userId: sellerUserIdNarrow, initialFundingRuleVersion: "initial-funding/v1", createdAt: now, balance: { total: { amount: 9500, currency: "GAME_CREDIT" }, available: { amount: 9460, currency: "GAME_CREDIT" }, frozen: { amount: 40, currency: "GAME_CREDIT" }, updatedAt: now } } })) }));
    await page.route("**/v1/ledger?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await mockOrderBookNarrow(page, [{ price: 210, qty: 2, orders: 1 }], [{ price: 220, qty: 3, orders: 1 }]);
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{ ...order("sell", 3, 200, "partially_filled", 2), id: orderId, remainingQuantity: 1 }], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await page.route("**/v1/orders/trades?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{
      id: "trade-narrow-1", skuId, role: "seller", myOrderId: orderId, quantity: 2, executionPrice: { amount: 200, currency: "GAME_CREDIT" },
      fee: { amount: 8, currency: "GAME_CREDIT" }, pendingFunds: { amount: 40, currency: "GAME_CREDIT" }, pendingInventoryQuantity: 2, ruleVersion: "order-matching/v1", status: "matched_pending_fulfillment", fulfillmentDeadline: "2026-07-29T08:00:00.000Z", createdAt: now, updatedAt: now
    }], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await recoverSessionAsNarrow(page, sellerUserIdNarrow, "seller-token-narrow");
    await page.goto("/orders");
    await expect(page.getByRole("heading", { name: "双边订单簿" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "我的成交与待履约资产" })).toBeVisible();
    await expect(page.getByText("待履约库存 2 张")).toBeVisible();
  });

  async function mockOrderBookNarrow(page: Page, bids: Array<{ price: number; qty: number; orders: number }>, asks: Array<{ price: number; qty: number; orders: number }>) {
    await page.route(`**/v1/orders/book/${skuId}`, async (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ book: { skuId, bids: bids.map((row) => ({ limitPrice: { amount: row.price, currency: "GAME_CREDIT" }, remainingQuantity: row.qty, orderCount: row.orders })), asks: asks.map((row) => ({ limitPrice: { amount: row.price, currency: "GAME_CREDIT" }, remainingQuantity: row.qty, orderCount: row.orders })), capturedAt: now } }))
    }));
  }
  async function recoverSessionAsNarrow(page: Page, userId: string, accessToken: string) {
    await page.context().addCookies([{ name: "mtg_csrf", value: `i19f-${userId}`, url: webBaseUrl }]);
    await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken, user: { id: userId, email: `i19f-${userId}@example.test`, displayName: "窄屏卖方", role: "player", createdAt: now } })) }));
  }
});

test.describe("P2P 模拟履约确认与取消（I20F）", () => {
  const buyerUserId = "10000000-0000-4000-8000-0000000002f1";
  const sellerUserId = "10000000-0000-4000-8000-0000000002f2";
  const tradeId = "trade-i20f-1";

  /** 买方视角待履约成交；含履约期限。 */
  function buyerPendingTrade(): Record<string, unknown> {
    return {
      id: tradeId, skuId, role: "buyer", myOrderId: "order-buyer-i20f",
      quantity: 2, executionPrice: { amount: 200, currency: "GAME_CREDIT" },
      fee: { amount: 8, currency: "GAME_CREDIT" },
      pendingFunds: { amount: 408, currency: "GAME_CREDIT" },
      pendingInventoryQuantity: null, ruleVersion: "order-matching/v1", status: "matched_pending_fulfillment",
      fulfillmentDeadline: "2026-07-29T08:00:00.000Z", createdAt: now, updatedAt: now
    };
  }
  /** 卖方视角待履约成交。 */
  function sellerPendingTrade(): Record<string, unknown> {
    return {
      id: tradeId, skuId, role: "seller", myOrderId: "order-seller-i20f",
      quantity: 2, executionPrice: { amount: 200, currency: "GAME_CREDIT" },
      fee: { amount: 8, currency: "GAME_CREDIT" },
      pendingFunds: { amount: 40, currency: "GAME_CREDIT" },
      pendingInventoryQuantity: 2, ruleVersion: "order-matching/v1", status: "matched_pending_fulfillment",
      fulfillmentDeadline: "2026-07-29T08:00:00.000Z", createdAt: now, updatedAt: now
    };
  }
  /** 服务端履约/取消履约命令响应：trade 携带推进后的状态与成交 ID（前端只取 status/updatedAt/id）。 */
  function tradeCommandResponse(status: "fulfilled" | "cancelled", userId: string) {
    return { trade: { id: tradeId, status, updatedAt: now }, balance: { total: { amount: 10000, currency: "GAME_CREDIT" }, available: { amount: 10000, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now, userId } };
  }

  async function mockOrderBook(page: Page) {
    await page.route(`**/v1/orders/book/${skuId}`, async (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ book: { skuId, bids: [], asks: [], capturedAt: now } }))
    }));
  }

  async function mockArchive(page: Page, userId: string, frozenAmount = 408) {
    await page.route("**/v1/archive", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ archive: { id: "archive-1", userId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now, balance: { total: { amount: 10000, currency: "GAME_CREDIT" }, available: { amount: 10000 - frozenAmount, currency: "GAME_CREDIT" }, frozen: { amount: frozenAmount, currency: "GAME_CREDIT" }, updatedAt: now } } })) }));
    await page.route("**/v1/ledger?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
  }

  async function recoverSessionAs(page: Page, userId: string, accessToken: string, displayName: string) {
    await page.context().addCookies([{ name: "mtg_csrf", value: `i20f-${userId}`, url: webBaseUrl }]);
    await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken, user: { id: userId, email: `i20f-${userId}@example.test`, displayName, role: "player", createdAt: now } })) }));
  }

  test("确认履约：二次确认后只发一个 POST，成功状态推进为已完成，重复点击不重复请求", async ({ page }) => {
    await mockMarket(page);
    await mockArchive(page, buyerUserId, 408);
    await mockOrderBook(page);
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await recoverSessionAs(page, buyerUserId, "buyer-token-i20f", "履约买方");
    let currentTrade = buyerPendingTrade();
    let fulfillCalls = 0; const keys: string[] = [];
    await page.route("**/v1/orders/trades?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [currentTrade], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await page.route(`**/v1/orders/trades/${tradeId}/fulfill`, async (route) => {
      fulfillCalls += 1; keys.push(route.request().headers()["idempotency-key"] ?? "");
      await new Promise((resolve) => setTimeout(resolve, 120));
      // 履约后服务端成交列表会推进为 fulfilled。
      currentTrade = { ...buyerPendingTrade(), status: "fulfilled", pendingFunds: null, pendingInventoryQuantity: null };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope(tradeCommandResponse("fulfilled", buyerUserId))) });
    });

    await page.goto("/orders");
    await page.getByRole("heading", { name: "我的成交与待履约资产" }).scrollIntoViewIfNeeded();
    await expect(page.locator("table").getByText("买方")).toBeVisible();
    await expect(page.locator("table").getByText("待履约").first()).toBeVisible();
    // 无实体物流声明可见。
    await expect(page.getByText("不涉及实体卡牌物流、发货或退货").first()).toBeVisible();

    // 确认履约：打开二次确认弹窗，展示期限、待履约资产与无物流声明。
    await page.getByRole("button", { name: "确认履约" }).click();
    await expect(page.getByRole("heading", { name: "确认履约" })).toBeVisible();
    await expect(page.getByText("待履约资金：408 游戏币（数量×成交价 + order_fee）")).toBeVisible();
    // 弹窗内展示派生自成交的履约期限。
    await expect(page.getByRole("dialog").getByText("履约期限")).toBeVisible();
    await expect(page.getByRole("dialog").getByText("不涉及实体卡牌物流、发货或退货")).toBeVisible();

    // 双击确认只触发一次提交；按钮在提交期间禁用。
    const confirm = page.getByRole("dialog").getByRole("button", { name: "确认履约" });
    await confirm.dblclick();
    await expect(page.getByRole("heading", { name: "履约已完成" })).toBeVisible();
    await expect(page.getByText("已确认履约")).toBeVisible();
    // 关联成交 ID 可作为账本核对入口。
    await expect(page.getByText(`关联成交 ID ${tradeId}`)).toBeVisible();
    expect(fulfillCalls).toBe(1);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test("取消履约：买方视角退回资金，状态推进为已取消", async ({ page }) => {
    await mockMarket(page);
    await mockArchive(page, buyerUserId, 408);
    await mockOrderBook(page);
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await recoverSessionAs(page, buyerUserId, "buyer-token-i20f-cancel", "取消买方");
    let currentTrade = buyerPendingTrade();
    let cancelCalls = 0;
    await page.route("**/v1/orders/trades?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [currentTrade], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await page.route(`**/v1/orders/trades/${tradeId}/cancel`, async (route) => {
      cancelCalls += 1;
      currentTrade = { ...buyerPendingTrade(), status: "cancelled", pendingFunds: null, pendingInventoryQuantity: null };
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(envelope(tradeCommandResponse("cancelled", buyerUserId))) });
    });

    await page.goto("/orders");
    await page.getByRole("heading", { name: "我的成交与待履约资产" }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "取消履约" }).click();
    await expect(page.getByRole("heading", { name: "取消履约" })).toBeVisible();
    // 买方视角：取消履约会退回待履约资金。
    await expect(page.getByText("你的待履约资金将退回可用额")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "确认取消履约" }).click();
    await expect(page.getByRole("heading", { name: "履约已取消" })).toBeVisible();
    await expect(page.getByText("你的待履约资金已退回")).toBeVisible();
    expect(cancelCalls).toBe(1);
  });

  test("到期：服务端推进为已取消后成交不可操作", async ({ page }) => {
    await mockMarket(page);
    await mockArchive(page, sellerUserId, 40);
    await mockOrderBook(page);
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await recoverSessionAs(page, sellerUserId, "seller-token-i20f-expired", "到期卖方");
    // 成交已被服务端（order.expire）推进为 cancelled；前端只读，不再展示履约/取消按钮。
    const expiredTrade = { ...sellerPendingTrade(), status: "cancelled" as const, pendingFunds: null, pendingInventoryQuantity: null };
    await page.route("**/v1/orders/trades?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [expiredTrade], page: { total: 1, hasMore: false, nextCursor: null } })) }));

    await page.goto("/orders");
    await page.getByRole("heading", { name: "我的成交与待履约资产" }).scrollIntoViewIfNeeded();
    await expect(page.locator("table").getByText("已取消").first()).toBeVisible();
    await expect(page.locator("table").getByText("不可操作")).toBeVisible();
    await expect(page.getByRole("button", { name: "确认履约" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "取消履约" })).toHaveCount(0);
  });

  test("失败重试：状态冲突时显示服务端原因并提示刷新，不伪造成功", async ({ page }) => {
    await mockMarket(page);
    await mockArchive(page, buyerUserId, 408);
    await mockOrderBook(page);
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await recoverSessionAs(page, buyerUserId, "buyer-token-i20f-fail", "履约失败买方");
    await page.route("**/v1/orders/trades?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [buyerPendingTrade()], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await page.route(`**/v1/orders/trades/${tradeId}/fulfill`, async (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(failure("RESOURCE_CONFLICT", "当前状态 matched_pending_fulfillment 不可确认履约")) }));

    await page.goto("/orders");
    await page.getByRole("heading", { name: "我的成交与待履约资产" }).scrollIntoViewIfNeeded();
    await page.getByRole("button", { name: "确认履约" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "确认履约" }).click();
    // 服务端拒绝原因展示为行内错误，并提供刷新成交列表；不展示伪造的成功横幅。
    await expect(page.getByText("当前状态 matched_pending_fulfillment 不可确认履约")).toBeVisible();
    await expect(page.getByRole("button", { name: "刷新成交列表" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "履约已完成" })).toHaveCount(0);
  });
});

test.describe("P2P 模拟履约确认与取消窄屏（390 × 844）", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("窄屏履约二次确认与无物流声明不阻断", async ({ page }) => {
    await mockMarket(page);
    const narrowUserId = "10000000-0000-4000-8000-0000000002f3";
    await page.route("**/v1/archive", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ archive: { id: "archive-1", userId: narrowUserId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now, balance: { total: { amount: 10000, currency: "GAME_CREDIT" }, available: { amount: 9592, currency: "GAME_CREDIT" }, frozen: { amount: 408, currency: "GAME_CREDIT" }, updatedAt: now } } })) }));
    await page.route("**/v1/ledger?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await page.route(`**/v1/orders/book/${skuId}`, async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ book: { skuId, bids: [], asks: [], capturedAt: now } })) }));
    await page.route("**/v1/orders?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) }));
    await page.route("**/v1/orders/trades?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{
      id: "trade-i20f-narrow", skuId, role: "buyer", myOrderId: "order-narrow", quantity: 2, executionPrice: { amount: 200, currency: "GAME_CREDIT" },
      fee: { amount: 8, currency: "GAME_CREDIT" }, pendingFunds: { amount: 408, currency: "GAME_CREDIT" }, pendingInventoryQuantity: null, ruleVersion: "order-matching/v1", status: "matched_pending_fulfillment", fulfillmentDeadline: "2026-07-29T08:00:00.000Z", createdAt: now, updatedAt: now
    }], page: { total: 1, hasMore: false, nextCursor: null } })) }));
    await page.context().addCookies([{ name: "mtg_csrf", value: `i20f-${narrowUserId}`, url: webBaseUrl }]);
    await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "narrow-token-i20f", user: { id: narrowUserId, email: `i20f-${narrowUserId}@example.test`, displayName: "窄屏履约买方", role: "player", createdAt: now } })) }));

    await page.goto("/orders");
    await page.getByRole("heading", { name: "我的成交与待履约资产" }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "确认履约" })).toBeVisible();
    await page.getByRole("button", { name: "确认履约" }).click();
    await expect(page.getByRole("heading", { name: "确认履约" })).toBeVisible();
    await expect(page.getByText("不涉及实体卡牌物流、发货或退货").first()).toBeVisible();
  });
});
