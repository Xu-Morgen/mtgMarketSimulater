import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-27T08:00:00.000Z";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const quote = {
  skuId: "30000000-0000-4000-8000-000000000141", quoteVersion: "market/v1",
  referencePrice: { amount: 123, currency: "EUR" }, marketPrice: { amount: 148, currency: "GAME_CREDIT" },
  npcBuyPrice: { amount: 132, currency: "GAME_CREDIT" }, npcSellPrice: { amount: 164, currency: "GAME_CREDIT" },
  validUntil: now, source: "mtgjson-cardmarket", capturedAt: now,
  reasons: [{ kind: "event", factorBasisPoints: 20_000, reason: "夏季冠军赛活动" }, { kind: "supply-demand", factorBasisPoints: 9_800, reason: "已结算需求 2、供给 10" }]
};
const quotedItem = { sku: { id: quote.skuId, name: "市场夹具卡", setCode: "TST", setName: "测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare" }, quote, tradable: true, tradeDisabledReason: null };
const unpricedItem = { sku: { id: "30000000-0000-4000-8000-000000000142", name: "无价夹具卡", setCode: "TST", setName: "测试系列", collectorNumber: "2", finish: "foil", rarity: "mythic" }, quote: null, tradable: false, tradeDisabledReason: "no_valid_reference_price" };

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i14f-e2e" } }; }

async function recoverPlayerSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "market-e2e-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({
    accessToken: "market-e2e-token",
    user: { id: "10000000-0000-4000-8000-000000000141", email: "market-e2e@example.test", displayName: "市场测试玩家", role: "player", createdAt: now }
  })) }));
}

test("市场页展示服务端双价格、过期状态、受界活动原因和禁用交易入口", async ({ page }) => {
  const quoteUrls: string[] = [];
  await page.route("**/v1/market/quotes?*", async (route) => {
    quoteUrls.push(route.request().url());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [quotedItem, unpricedItem], page: { total: 2, hasMore: false, nextCursor: null } })) });
  });
  await page.route("**/v1/market/index", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ referenceIndex: 123, gameIndex: 148, quotedSkus: 1, capturedAt: now })) }));
  await page.route("**/v1/prices/status", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "stale" })) }));
  await recoverPlayerSession(page);
  await page.goto("/market");
  await expect(page.getByRole("heading", { name: "市场" })).toBeVisible();
  await expect(page.getByText("MTGJSON / Cardmarket EUR 参考价")).toBeVisible();
  await expect(page.getByText("同步失败，沿用旧快照")).toBeVisible();
  await expect(page.getByText("这不是实时 Cardmarket 价格。")).toBeVisible();
  await expect(page.getByText("NPC 买入：132 游戏币")).toBeVisible();
  await expect(page.getByText("NPC 卖出：164 游戏币")).toBeVisible();
  await expect(page.getByText("市场活动：夏季冠军赛活动（服务端系数 20000 bp）")).toBeVisible();
  await expect(page.getByRole("button", { name: "暂不可交易" })).toBeDisabled();
  await expect(page.getByText("无有效参考价，暂不可新增交易").last()).toBeVisible();
  await page.getByLabel("市场工艺筛选").selectOption("foil");
  await page.getByLabel("市场交易状态筛选").selectOption("untradable");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page).toHaveURL(/finish=foil/); await expect(page).toHaveURL(/tradable=untradable/);
  expect(quoteUrls.every((url) => url.includes("/v1/market/quotes?") && !url.includes("mtgjson") && !url.includes("scryfall"))).toBe(true);
});

test("市场报价查询失败时不会伪造价格或可交易状态，并可重试", async ({ page }) => {
  let failed = true;
  await page.route("**/v1/market/quotes?*", async (route) => failed
    ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "市场投影暂不可用" }, meta: { requestId: "i14f-failure" } }) })
    : route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [unpricedItem], page: { total: 1, hasMore: false, nextCursor: null } })) })
  );
  await page.route("**/v1/market/index", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ referenceIndex: null, gameIndex: null, quotedSkus: 0, capturedAt: null })) }));
  await page.route("**/v1/prices/status", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: null, updatedAt: null, freshness: "unavailable" })) }));
  await recoverPlayerSession(page);
  await page.goto("/market");
  await expect(page.getByRole("heading", { name: "市场报价加载失败" })).toBeVisible();
  failed = false;
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("无价夹具卡")).toBeVisible();
  await expect(page.getByText("无有效参考价，暂不可新增交易").last()).toBeVisible();
});
