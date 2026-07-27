import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-27T08:00:00.000Z";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const skuId = "30000000-0000-4000-8000-000000000151";
const quoteId = "40000000-0000-4000-8000-000000000151";
const userId = "10000000-0000-4000-8000-000000000151";
const quote = {
  quoteId, skuId, quoteVersion: "market/v1", referencePrice: { amount: 123, currency: "EUR" },
  marketPrice: { amount: 148, currency: "GAME_CREDIT" }, npcBuyPrice: { amount: 132, currency: "GAME_CREDIT" },
  npcSellPrice: { amount: 164, currency: "GAME_CREDIT" }, validUntil: "2026-07-27T10:00:00.000Z",
  source: "mtgjson-cardmarket", capturedAt: now, reasons: []
};
const item = { sku: { id: skuId, name: "NPC 买入夹具卡", setCode: "TST", setName: "测试系列", collectorNumber: "51", finish: "nonfoil", rarity: "rare" }, quote, tradable: true, tradeDisabledReason: null };

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i15f-e2e" } }; }
function failure(code: string, message: string) { return { ok: false, error: { code, message }, meta: { requestId: "i15f-failure" } }; }
function preview(quantity: number, unavailableReason: "archive_required" | "insufficient_balance" | "trade_limit_reached" | null = null) {
  return {
    skuId, quantity, quoteId, quoteVersion: "market/v1", unitPrice: { amount: 164, currency: "GAME_CREDIT" }, unitFee: { amount: 16, currency: "GAME_CREDIT" },
    total: { amount: 164 * quantity, currency: "GAME_CREDIT" }, fee: { amount: 16 * quantity, currency: "GAME_CREDIT" }, validUntil: quote.validUntil,
    limit: { maxQuantityPerTrade: 4, maxQuantityPerUserSkuDay: 6, remainingQuantityToday: 3 }, canPurchase: unavailableReason === null, unavailableReason
  };
}
function settlement(quantity: number) {
  return {
    trade: { id: "50000000-0000-4000-8000-000000000151", userId, skuId, side: "buy", quantity, quoteId, quoteVersion: "market/v1", unitPrice: { amount: 164, currency: "GAME_CREDIT" }, unitFee: { amount: 16, currency: "GAME_CREDIT" }, total: { amount: 164 * quantity, currency: "GAME_CREDIT" }, fee: { amount: 16 * quantity, currency: "GAME_CREDIT" }, settledAt: now },
    balance: { total: { amount: 9_672, currency: "GAME_CREDIT" }, available: { amount: 9_672, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now },
    holding: { skuId, quantity, availableQuantity: quantity, orderLockedQuantity: 0, tournamentLockedQuantity: 0, averageCost: { amount: 164, currency: "GAME_CREDIT" }, marketValue: { amount: 148 * quantity, currency: "GAME_CREDIT" }, marketValueUnavailableReason: null, updatedAt: now, sku: { ...item.sku, imagePath: null, tradable: true } }
  };
}

async function recoverPlayerSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "npc-buy-e2e-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "npc-buy-e2e-token", user: { id: userId, email: "npc-buy-e2e@example.test", displayName: "NPC 买入测试玩家", role: "player", createdAt: now } })) }));
}

async function mockMarket(page: Page): Promise<void> {
  await page.route("**/v1/market/quotes?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [item], page: { total: 1, hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/market/index", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ referenceIndex: 123, gameIndex: 148, quotedSkus: 1, capturedAt: now })) }));
  await page.route("**/v1/prices/status", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "fresh" })) }));
}

test("NPC 买入按服务端预览确认，重复点击只提交一笔成交并刷新结果", async ({ page }) => {
  await mockMarket(page);
  const previewQuantities: number[] = [];
  const keys: string[] = [];
  let postCalls = 0;
  await page.route(`**/v1/npc-trades/buy/${skuId}/preview?*`, async (route) => {
    const quantity = Number(new URL(route.request().url()).searchParams.get("quantity"));
    previewQuantities.push(quantity);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: preview(quantity) })) });
  });
  await page.route(`**/v1/npc-trades/buy/${skuId}`, async (route) => {
    postCalls += 1;
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({ quoteId, quoteVersion: "market/v1", quantity: 2, maxUnitPrice: 164 });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope(settlement(2))) });
  });
  await recoverPlayerSession(page);
  await page.goto("/market");
  await page.getByRole("button", { name: "向 NPC 买入" }).click();
  await expect(page.getByRole("heading", { name: "向 NPC 买入" })).toBeVisible();
  await page.getByLabel("买入数量").fill("2");
  await page.getByRole("button", { name: "获取服务端预览" }).click();
  await expect(page.getByText("本次总扣款：328 游戏币")).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认向 NPC 买入" });
  await confirm.click();
  await expect(page.getByRole("button", { name: "正在由服务端成交…" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "买入已完成" })).toBeVisible();
  await expect(page.getByText("服务端已成交 2 张，实际扣款 328 游戏币（其中费用 32 游戏币）。")).toBeVisible();
  expect(postCalls).toBe(1);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
  expect(previewQuantities).toContain(1);
  expect(previewQuantities).toContain(2);
});

test("余额不足、额度、报价过期均由服务端提示，重新预览后可恢复成交", async ({ page }) => {
  await mockMarket(page);
  let previewState: "balance" | "limit" | "valid" = "balance";
  let postCalls = 0;
  const keys: string[] = [];
  await page.route(`**/v1/npc-trades/buy/${skuId}/preview?*`, async (route) => {
    const quantity = Number(new URL(route.request().url()).searchParams.get("quantity"));
    const unavailable = previewState === "balance" ? "insufficient_balance" : previewState === "limit" ? "trade_limit_reached" : null;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ preview: preview(quantity, unavailable) })) });
  });
  await page.route(`**/v1/npc-trades/buy/${skuId}`, async (route) => {
    postCalls += 1;
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (postCalls === 1) return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(failure("VERSION_STALE", "报价已过期，请重新获取服务端预览")) });
    return route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope(settlement(1))) });
  });
  await recoverPlayerSession(page);
  await page.goto("/market");
  await page.getByRole("button", { name: "向 NPC 买入" }).click();
  await expect(page.getByText("可用余额不足，无法按此服务端预览成交。")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认向 NPC 买入" })).toBeDisabled();
  previewState = "limit";
  await page.getByRole("button", { name: "获取服务端预览" }).click();
  await expect(page.getByText("已达到服务端单笔或今日该卡交易额度。")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认向 NPC 买入" })).toBeDisabled();
  previewState = "valid";
  await page.getByRole("button", { name: "获取服务端预览" }).click();
  await expect(page.getByRole("button", { name: "确认向 NPC 买入" })).toBeEnabled();
  await page.getByRole("button", { name: "确认向 NPC 买入" }).click();
  await expect(page.getByText("报价已过期，请重新获取服务端预览")).toBeVisible();
  await page.getByRole("button", { name: "获取服务端预览" }).click();
  await page.getByRole("button", { name: "确认向 NPC 买入" }).click();
  await expect(page.getByRole("heading", { name: "买入已完成" })).toBeVisible();
  expect(postCalls).toBe(2);
  expect(keys[0]).not.toBe(keys[1]);
});
