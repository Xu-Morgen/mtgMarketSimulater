import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-27T08:00:00.000Z";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const skuId = "30000000-0000-4000-8000-000000000161";
const quoteId = "40000000-0000-4000-8000-000000000161";
const userId = "10000000-0000-4000-8000-000000000161";

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i16f-e2e" } }; }
function failure(code: string, message: string) { return { ok: false, error: { code, message }, meta: { requestId: "i16f-failure" } }; }
function holding(input: Partial<{ quantity: number; availableQuantity: number; orderLockedQuantity: number; tournamentLockedQuantity: number }> = {}) {
  const quantity = input.quantity ?? 5; const availableQuantity = input.availableQuantity ?? 3; const orderLockedQuantity = input.orderLockedQuantity ?? 2; const tournamentLockedQuantity = input.tournamentLockedQuantity ?? 0;
  return {
    skuId, quantity, availableQuantity, orderLockedQuantity, tournamentLockedQuantity,
    averageCost: { amount: 120, currency: "GAME_CREDIT" }, marketUnitPrice: { amount: 150, currency: "GAME_CREDIT" }, marketValue: { amount: quantity * 150, currency: "GAME_CREDIT" }, unrealizedProfitLoss: { amount: quantity * 30, currency: "GAME_CREDIT" }, marketValueUnavailableReason: null, updatedAt: now,
    sku: { id: skuId, name: "NPC 卖出夹具卡", setCode: "TST", setName: "测试系列", collectorNumber: "61", finish: "nonfoil", imagePath: null, tradable: true }
  };
}
function preview(quantity: number, unavailableReason: "archive_required" | "insufficient_inventory" | "trade_limit_reached" | null = null) {
  return {
    skuId, quantity, availableQuantity: 3, quoteId, quoteVersion: "market/v1", unitPrice: { amount: 170, currency: "GAME_CREDIT" }, unitFee: { amount: 20, currency: "GAME_CREDIT" }, total: { amount: quantity * 170, currency: "GAME_CREDIT" }, fee: { amount: quantity * 20, currency: "GAME_CREDIT" }, validUntil: "2026-07-27T10:00:00.000Z",
    limit: { maxQuantityPerTrade: 4, maxQuantityPerUserSkuDay: 6, remainingQuantityToday: 3 }, canSell: unavailableReason === null, unavailableReason
  };
}
function settlement(quantity: number) {
  return {
    trade: { id: "50000000-0000-4000-8000-000000000161", userId, skuId, side: "sell", quantity, quoteId, quoteVersion: "market/v1", unitPrice: { amount: 170, currency: "GAME_CREDIT" }, unitFee: { amount: 20, currency: "GAME_CREDIT" }, total: { amount: quantity * 170, currency: "GAME_CREDIT" }, fee: { amount: quantity * 20, currency: "GAME_CREDIT" }, settledAt: now },
    balance: { total: { amount: 10_510, currency: "GAME_CREDIT" }, available: { amount: 10_510, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now },
    holding: holding({ quantity: 2, availableQuantity: 0, orderLockedQuantity: 2 })
  };
}

async function recoverPlayerSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "npc-sell-e2e-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "npc-sell-e2e-token", user: { id: userId, email: "npc-sell-e2e@example.test", displayName: "NPC 卖出测试玩家", role: "player", createdAt: now } })) }));
}

async function mockInventory(page: Page, getHolding: () => ReturnType<typeof holding>): Promise<void> {
  await page.route("**/v1/inventory?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [getHolding()], page: { total: 1, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/prices/status", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "fresh" })) }));
}

test("NPC 卖出仅以服务端 all 预览成交，重复点击不重复出售，刷新后读取服务器库存", async ({ page }) => {
  let currentHolding = holding(); let postCalls = 0; const keys: string[] = [];
  await mockInventory(page, () => currentHolding);
  await page.route(`**/v1/npc-trades/sell/${skuId}/preview?*`, async (route) => {
    const quantity = new URL(route.request().url()).searchParams.get("quantity");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: preview(quantity === "all" ? 3 : Number(quantity)) })) });
  });
  await page.route(`**/v1/npc-trades/sell/${skuId}`, async (route) => {
    postCalls += 1; keys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({ quoteId, quoteVersion: "market/v1", quantity: 3, minUnitPrice: 170 });
    currentHolding = holding({ quantity: 2, availableQuantity: 0, orderLockedQuantity: 2 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope(settlement(3))) });
  });
  await recoverPlayerSession(page);
  await page.goto("/inventory");
  await expect(page.getByRole("columnheader", { name: "服务端现价 / 市值" })).toBeVisible();
  await expect(page.getByText("150 游戏币 / 张")).toBeVisible();
  await expect(page.getByText("市值 750 游戏币")).toBeVisible();
  await expect(page.getByText("150 游戏币", { exact: true })).toBeVisible();
  await expect(page.getByText("已锁定（仅可卖出可用量）")).toBeVisible();
  await page.getByRole("button", { name: "向 NPC 卖出" }).click();
  await page.getByRole("button", { name: "全部可用库存" }).click();
  await expect(page.getByText("本次出售：3 张（当前可用 3 张）")).toBeVisible();
  await expect(page.getByText("本次预计收入：510 游戏币")).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认向 NPC 卖出" });
  await confirm.dblclick();
  await expect(page.getByRole("heading", { name: "卖出已完成" })).toBeVisible();
  await expect(page.getByText("服务端已成交 3 张，实际收入 510 游戏币（其中费用 60 游戏币）。")).toBeVisible();
  expect(postCalls).toBe(1); expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  await page.reload();
  await expect(page.getByRole("button", { name: "无可用库存" })).toBeDisabled();
});

test("锁定或数量不足库存均不出售，服务器预览明确拒绝且确认保持禁用", async ({ page }) => {
  await mockInventory(page, () => holding({ quantity: 2, availableQuantity: 0, orderLockedQuantity: 2 }));
  await recoverPlayerSession(page);
  await page.goto("/inventory");
  await expect(page.getByRole("button", { name: "无可用库存" })).toBeDisabled();
  await expect(page.getByText("已锁定（仅可卖出可用量）")).toBeVisible();

  await page.unroute("**/v1/inventory?*");
  await mockInventory(page, () => holding());
  await page.reload();
  await page.route(`**/v1/npc-trades/sell/${skuId}/preview?*`, async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: preview(1, "insufficient_inventory") })) }));
  await page.getByRole("button", { name: "向 NPC 卖出" }).click();
  await expect(page.getByText("当前可用库存不足；订单和比赛锁定的卡牌不能出售。")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认向 NPC 卖出" })).toBeDisabled();
});

test("报价变化要求重新预览；指定数量确认只提交服务端预览的单价和新幂等键", async ({ page }) => {
  await mockInventory(page, () => holding());
  let postCalls = 0; const keys: string[] = [];
  await page.route(`**/v1/npc-trades/sell/${skuId}/preview?*`, async (route) => {
    const quantity = Number(new URL(route.request().url()).searchParams.get("quantity"));
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: preview(quantity) })) });
  });
  await page.route(`**/v1/npc-trades/sell/${skuId}`, async (route) => {
    postCalls += 1; keys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({ quoteId, quoteVersion: "market/v1", quantity: 2, minUnitPrice: 170 });
    if (postCalls === 1) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(failure("VERSION_STALE", "NPC 收购价已变化，请重新获取服务端预览")) });
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope(settlement(2))) });
  });
  await recoverPlayerSession(page);
  await page.goto("/inventory");
  await page.getByRole("button", { name: "向 NPC 卖出" }).click();
  await page.getByLabel("卖出数量").fill("2");
  await page.getByRole("button", { name: "获取服务端预览" }).click();
  await page.getByRole("button", { name: "确认向 NPC 卖出" }).click();
  await expect(page.getByText("NPC 收购价已变化，请重新获取服务端预览")).toBeVisible();
  await page.getByRole("button", { name: "重新预览" }).click();
  await page.getByRole("button", { name: "确认向 NPC 卖出" }).click();
  await expect(page.getByRole("heading", { name: "卖出已完成" })).toBeVisible();
  expect(postCalls).toBe(2); expect(keys[0]).not.toBe(keys[1]);
});
