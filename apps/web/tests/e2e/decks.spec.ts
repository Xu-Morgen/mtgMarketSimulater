import { expect, test, type Page } from "@playwright/test";

const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const now = "2026-07-29T08:00:00.000Z";
const userId = "10000000-0000-4000-8000-00000000024f";
const commanderId = "10000000-0000-4000-8000-000000000241";
const companionId = "10000000-0000-4000-8000-000000000242";
const savedDeckId = "10000000-0000-4000-8000-000000000249";

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i24f-e2e" } }; }
function holdings(input: Array<{ id: string; name: string; available?: number; orderLocked?: number; tournamentLocked?: number; colors?: string[]; colorIdentity?: string[]; manaCost?: string | null; typeLine?: string; oracleText?: string | null; power?: string | null; toughness?: string | null }> = []) {
  return {
    items: input.map((card) => ({
      skuId: card.id, quantity: (card.available ?? 1) + (card.orderLocked ?? 0) + (card.tournamentLocked ?? 0), availableQuantity: card.available ?? 1,
      orderLockedQuantity: card.orderLocked ?? 0, tournamentLockedQuantity: card.tournamentLocked ?? 0,
      averageCost: { amount: 10, currency: "GAME_CREDIT" }, marketUnitPrice: null, marketValue: null, unrealizedProfitLoss: null, marketValueUnavailableReason: "price_unavailable",
      sku: { id: card.id, name: card.name, setCode: "TST", setName: "测试系列", collectorNumber: "1", finish: "nonfoil", tradable: true, imagePath: null, manaCost: card.manaCost ?? "{1}{R}", colors: card.colors ?? ["R"], colorIdentity: card.colorIdentity ?? ["R"], typeLine: card.typeLine ?? "Creature — Test", oracleText: card.oracleText ?? "当此牌进战场时，抓一张牌。", power: card.power ?? "2", toughness: card.toughness ?? "2" }
    })), page: { total: input.length, hasMore: false, nextCursor: null }
  };
}
function legalLegality(valid: boolean, issues: string[] = []) { return { valid, totalCards: 100, colorIdentity: ["R"], issues, ruleVersion: "commander-100/v1", banlistVersion: "commander-banlist/2026-07-29", checkedAt: now }; }

async function session(page: Page) {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i24f-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "i24f-token", user: { id: userId, email: "decks@example.test", displayName: "卡组测试玩家", role: "player", createdAt: now } })) }));
}
async function mockDeckPage(page: Page, stock: Array<{ id: string; name: string; available?: number; orderLocked?: number; tournamentLocked?: number; colors?: string[]; colorIdentity?: string[]; manaCost?: string | null; typeLine?: string; oracleText?: string | null; power?: string | null; toughness?: string | null }> = []) {
  await page.route("**/v1/decks", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await page.route("**/v1/inventory**", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(holdings(stock))) }));
}

test("空库存、虚拟基本地与评分未生成状态均由服务端边界说明", async ({ page }) => {
  await mockDeckPage(page);
  let savedBody: unknown = null;
  await page.route("**/v1/decks", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    savedBody = route.request().postDataJSON();
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ id: savedDeckId, name: "虚拟基本地草稿", format: "commander-100/v1", ruleVersion: "commander-100/v1", banlistVersion: "commander-banlist/2026-07-29", cards: [{ zone: "virtual_basic", skuId: null, virtualBasic: "mountain", quantity: 99, name: "山脉", cardIdentity: "virtual:mountain" }], legality: legalLegality(false, ["必须恰好 100 张"]), strengthSnapshot: null, createdAt: now, updatedAt: now })) });
  });
  await page.route(`**/v1/decks/${savedDeckId}`, async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ id: savedDeckId, name: "虚拟基本地草稿", format: "commander-100/v1", ruleVersion: "commander-100/v1", banlistVersion: "commander-banlist/2026-07-29", cards: [{ zone: "virtual_basic", skuId: null, virtualBasic: "mountain", quantity: 99, name: "山脉", cardIdentity: "virtual:mountain" }], legality: legalLegality(false, ["必须恰好 100 张"]), strengthSnapshot: null, createdAt: now, updatedAt: now })) }));
  await session(page);
  await page.goto("/decks/new");
  await expect(page.getByText("没有匹配的可用库存。")).toBeVisible();
  await expect(page.getByText("当前草稿尚无报名评分；评分只在未来报名流程由服务器生成。")).toBeVisible();
  await page.getByLabel("山脉 数量").fill("99");
  await expect(page.getByText("虚拟基本地不引用 SKU")).toBeVisible();
  await expect(page.getByRole("heading", { name: /已选卡牌/ })).toContainText("已选卡牌 0 张 · 卡组总数 99 张 *");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page.getByText("卡组名称必须填写。")).toBeVisible();
  await expect(page.getByLabel("卡组名称")).toHaveAttribute("aria-invalid", "true");
  await page.getByLabel("卡组名称").fill("虚拟基本地草稿");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await expect(page).toHaveURL(`/decks/${savedDeckId}`);
  expect(savedBody).toMatchObject({ name: "虚拟基本地草稿", cards: [{ zone: "virtual_basic", virtualBasic: "mountain", quantity: 99 }] });
});

test("Companion、合法与非法 Commander 结果都只展示服务端返回", async ({ page }) => {
  await mockDeckPage(page, [{ id: commanderId, name: "赤焰指挥官", typeLine: "Legendary Creature — Human" }, { id: companionId, name: "忠诚伙伴" }]);
  const received: unknown[] = [];
  await page.route("**/v1/decks/validate", async (route) => {
    received.push(route.request().postDataJSON());
    const body = route.request().postDataJSON() as { cards: Array<{ zone: string; virtualBasic?: string }> };
    const island = body.cards.some((card) => card.zone === "virtual_basic" && card.virtualBasic === "island");
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(legalLegality(!island, island ? ["颜色标识不符合指挥官限制"] : []))) });
  });
  await session(page);
  await page.goto("/decks/new");
  await page.getByRole("button", { name: "设为指挥官" }).first().click();
  await page.getByRole("button", { name: "设为 Companion" }).click();
  await page.getByLabel("山脉 数量").fill("99");
  await page.getByRole("button", { name: "请求服务端检查" }).click();
  await expect(page.getByText("服务端合法性结果：可用于后续报名检查")).toBeVisible();
  expect(received[0]).toMatchObject({ cards: expect.arrayContaining([{ zone: "commander", skuId: commanderId, quantity: 1 }, { zone: "companion", skuId: companionId, quantity: 1 }, { zone: "virtual_basic", virtualBasic: "mountain", quantity: 99 }]) });
  await page.getByLabel("岛 数量").fill("99");
  await page.getByRole("button", { name: "请求服务端检查" }).click();
  await expect(page.getByText("颜色标识不符合指挥官限制")).toBeVisible();
  await expect(page.getByText("服务端合法性结果：存在问题")).toBeVisible();
});

test("订单/比赛锁定冲突与未保存离开提示不会由浏览器绕过", async ({ page }) => {
  await mockDeckPage(page, [{ id: commanderId, name: "锁定指挥官", available: 1, orderLocked: 2, tournamentLocked: 3, typeLine: "Legendary Creature — Human" }]);
  await page.route("**/v1/decks/validate", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(legalLegality(false, ["可用库存不足：锁定指挥官"]))) }));
  await session(page);
  await page.goto("/decks/new");
  await expect(page.getByText("订单锁定 2；比赛锁定 3")).toBeVisible();
  await page.getByRole("button", { name: "设为指挥官" }).click();
  await page.getByLabel("山脉 数量").fill("99");
  await page.getByRole("button", { name: "请求服务端检查" }).click();
  await expect(page.getByText("可用库存不足：锁定指挥官")).toBeVisible();
  await page.getByLabel("卡组名称").fill("尚未保存的锁定冲突草稿");
  let dialogType: string | null = null;
  page.once("dialog", (dialog) => { dialogType = dialog.type(); void dialog.accept(); });
  await page.reload();
  expect(dialogType).toBe("beforeunload");
});

test("库存表格展示服务端卡牌资料，指挥官选择自动按颜色筛选", async ({ page }) => {
  const blueId = "10000000-0000-4000-8000-000000000243";
  const redSpellId = "10000000-0000-4000-8000-000000000244";
  await mockDeckPage(page, [
    { id: commanderId, name: "赤焰指挥官", colors: ["R"], colorIdentity: ["R"], manaCost: "{2}{R}", typeLine: "Legendary Creature — Human", oracleText: "你操控的红色咒语不能被反击。", power: "3", toughness: "3" },
    { id: blueId, name: "蔚蓝神器", colors: ["U"], colorIdentity: ["U"], manaCost: "{1}{U}", typeLine: "Artifact", oracleText: "横置：占卜 1。", power: null, toughness: null },
    { id: redSpellId, name: "熔岩冲击", colors: ["R"], colorIdentity: ["R"], manaCost: "{R}", typeLine: "Instant", oracleText: "熔岩冲击对任意目标造成 3 点伤害。", power: null, toughness: null }
  ]);
  await page.route(`**/v1/catalog/cards/${commanderId}`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ sku: { id: commanderId, printingId: "printing-1", scryfallId: commanderId, name: "赤焰指挥官", setCode: "TST", setName: "测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare", manaCost: "{2}{R}", colors: ["R"], colorIdentity: ["R"], typeLine: "Legendary Creature — Human", power: "3", toughness: "3", oracleText: "你操控的红色咒语不能被反击。", artist: null, releasedAt: null, legalities: {}, source: "manual-test", sourceReference: "fixture", isManualException: true, imagePath: null, tradable: true, image: { path: null, sourceUrl: null, status: "missing", cachedAt: null } } })) }));
  await session(page); await page.goto("/decks/new");
  await expect(page.getByRole("columnheader", { name: "费用 / 颜色" })).toBeVisible(); await expect(page.getByRole("columnheader", { name: "攻 / 防" })).toBeVisible(); await expect(page.getByText("Legendary Creature — Human")).toBeVisible();
  await page.getByLabel("类别筛选").selectOption("legendary"); await expect(page.getByRole("button", { name: "设为指挥官" })).toHaveCount(1); await page.getByLabel("类别筛选").selectOption("all");
  await page.getByRole("button", { name: "设为指挥官" }).first().click();
  await expect(page.getByText("已按指挥官颜色标识自动筛选")).toBeVisible(); await expect(page.getByText("赤焰指挥官", { exact: true })).toHaveCount(1); await expect(page.getByText("熔岩冲击", { exact: true })).toBeVisible(); await expect(page.getByText("蔚蓝神器", { exact: true })).toHaveCount(0);
  await page.getByLabel("类别筛选").selectOption("creature"); await expect(page.getByText("熔岩冲击", { exact: true })).toHaveCount(0);
  await page.getByLabel("类别筛选").selectOption("all"); await page.getByLabel("预览 熔岩冲击 卡图").hover(); await expect(page.getByText("暂无本地图片；管理员可按需缓存该印刷的卡图。")).toBeVisible();
});

test("库存表格固定每页十行，并可翻至下一页", async ({ page }) => {
  const stock = Array.from({ length: 11 }, (_, index) => ({
    id: `10000000-0000-4000-8000-${String(300 + index).padStart(12, "0")}`,
    name: index === 10 ? "分页第十一张" : `分页测试卡 ${index + 1}`
  }));
  await mockDeckPage(page, stock);
  await session(page); await page.goto("/decks/new");
  await expect(page.getByText("第 1–10 张，共 11 张")).toBeVisible();
  await expect(page.getByText("分页第十一张", { exact: true })).toHaveCount(0);
  await page.locator(".ant-pagination-item-2").click();
  await expect(page.getByText("第 11–11 张，共 11 张")).toBeVisible();
  await expect(page.getByText("分页第十一张", { exact: true })).toBeVisible();
});

test("只有传奇生物可在库存表格中设为指挥官", async ({ page }) => {
  await mockDeckPage(page, [
    { id: commanderId, name: "传奇生物", typeLine: "Legendary Creature — Human" },
    { id: companionId, name: "普通生物", typeLine: "Creature — Human" }
  ]);
  await session(page); await page.goto("/decks/new");
  await expect(page.getByRole("button", { name: "设为指挥官" }).first()).toBeEnabled();
  await expect(page.getByRole("button", { name: "设为指挥官" }).nth(1)).toBeDisabled();
});
