import { expect, test, type Page } from "@playwright/test";

const password = "playwright-password-123";
const activePackId = "50000000-0000-4000-8000-000000000011";
const disabledPackId = "50000000-0000-4000-8000-000000000012";
const activePack = {
  id: activePackId,
  code: "PLAY-01",
  name: "测试补充包",
  description: "用于验证服务端概率公示和开包。",
  price: { amount: 500, currency: "GAME_CREDIT" },
  enabled: true,
  disabledReason: null,
  ruleVersion: "pack/v1",
  updatedAt: "2026-07-26T08:00:00.000Z",
  slots: [
    {
      id: "regular",
      draws: 2,
      rarityProbabilities: [
        { rarity: "common", probabilityBasisPoints: 9000 },
        { rarity: "rare", probabilityBasisPoints: 1000 }
      ]
    }
  ]
};
const disabledPack = {
  ...activePack,
  id: disabledPackId,
  code: "PLAY-02",
  name: "已结束补充包",
  enabled: false,
  disabledReason: "活动已结束"
};
const opening = {
  id: "70000000-0000-4000-8000-000000000011",
  packId: activePackId,
  packRuleVersion: "pack/v1",
  spent: { amount: 500, currency: "GAME_CREDIT" },
  received: [
    {
      skuId: "30000000-0000-4000-8000-000000000011",
      quantity: 1,
      cost: { amount: 250, currency: "GAME_CREDIT" },
      referencePrice: null,
      gamePrice: null,
      priceStatus: "unavailable_until_i17"
    },
    {
      skuId: "30000000-0000-4000-8000-000000000012",
      quantity: 1,
      cost: { amount: 250, currency: "GAME_CREDIT" },
      referencePrice: null,
      gamePrice: null,
      priceStatus: "unavailable_until_i17"
    }
  ],
  profitLoss: {
    spent: { amount: 500, currency: "GAME_CREDIT" },
    referenceValue: null,
    gameValue: null,
    referenceProfitLoss: null,
    gameProfitLoss: null,
    priceStatus: "unavailable_until_i17"
  },
  // I33B：开包结果必须携带服务端汇总成本与估值（本示例无有效报价，故 totalGameValue 置 null，与 profitLoss 一致）。
  totalCost: { amount: 500, currency: "GAME_CREDIT" },
  totalGameValue: null,
  openedAt: "2026-07-26T09:30:00.000Z"
};
const firstReceivedSkuId = "30000000-0000-4000-8000-000000000011";
const openingCards = [
  { id: firstReceivedSkuId, name: "测试火花法师", rarity: "rare" },
  { id: "30000000-0000-4000-8000-000000000012", name: "测试林地精灵", rarity: "common" }
];

function envelope(data: unknown) {
  return { ok: true, data, meta: { requestId: "i12f-e2e" } };
}

function failure(code: string, message: string) {
  return { ok: false, error: { code, message }, meta: { requestId: "i12f-failure" } };
}

async function registerPlayer(page: Page): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("补充包测试玩家");
  await page
    .getByLabel("邮箱")
    .fill(`packs-${test.info().project.name}-${test.info().testId}-${Date.now()}@example.test`);
  await page.getByRole("textbox", { name: "密码" }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("link", { name: "补充包商店" })).toBeVisible();
}

async function mockPackList(page: Page, items = [activePack, disabledPack]): Promise<void> {
  await page.route("**/v1/packs", async (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items })) })
  );
}

/** 开包结果补充展示资料与当前报价时，浏览器仍只请求本地 API。 */
async function mockOpeningPresentations(page: Page): Promise<void> {
  await page.route("**/v1/catalog/cards/30000000-0000-4000-8000-00000000001*", async (route) => {
    const card = openingCards.find((item) => route.request().url().endsWith(item.id));
    if (!card) return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify(failure("RESOURCE_NOT_FOUND", "卡牌不存在")) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ sku: {
      ...card, printingId: `printing-${card.id}`, scryfallId: `scryfall-${card.id}`, setCode: "TST", setName: "测试系列", collectorNumber: "1", finish: "nonfoil", legalities: {}, imagePath: null, tradable: true, source: "scryfall", sourceReference: null, isManualException: false,
      image: { path: null, sourceUrl: null, status: "missing", cachedAt: null }, oracleText: null, artist: null, releasedAt: null
    } })) });
  });
  await page.route("**/v1/market/quotes/30000000-0000-4000-8000-00000000001*", async (route) => {
    const skuId = openingCards.find((item) => route.request().url().endsWith(item.id))?.id;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ quote: {
      skuId, quoteVersion: "market/v1", referencePrice: { amount: 25, currency: "EUR" }, marketPrice: { amount: 250, currency: "GAME_CREDIT" }, npcBuyPrice: { amount: 225, currency: "GAME_CREDIT" }, npcSellPrice: { amount: 275, currency: "GAME_CREDIT" }, validUntil: "2026-07-27T10:00:00.000Z", source: "mtgjson-cardmarket", capturedAt: "2026-07-27T09:00:00.000Z", reasons: []
    } })) });
  });
}

test("玩家可查看服务端概率和禁用原因，并从详情返回商店购买", async ({ page }) => {
  await registerPlayer(page);
  await mockPackList(page);
  await page.route(`**/v1/packs/${activePackId}`, async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ pack: activePack }))
    })
  );
  await page.getByRole("link", { name: "补充包商店" }).click();
  await expect(page.getByRole("heading", { name: "补充包商店" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("当前不可购买：")).toBeVisible();
  await expect(page.getByText("活动已结束")).toBeVisible();
  await expect(page.getByRole("button", { name: "购买并开包" }).first()).toBeEnabled();
  await expect(page.getByRole("button", { name: "购买并开包" }).nth(1)).toBeDisabled();
  await page.getByRole("link", { name: "查看概率详情" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/packs/${activePackId}$`));
  await expect(page.getByRole("heading", { name: "测试补充包" })).toBeVisible();
  await expect(page.getByText("pack/v1")).toBeVisible();
  await expect(page.getByText("90.00%（9,000 bp）")).toBeVisible();
  await expect(page.getByText("MVP 未启用保底机制")).toBeVisible();
  await expect(page.getByRole("link", { name: "返回商店购买" })).toBeVisible();
});

test("购买预览、重复点击、跳过动画和刷新历史只展示一次服务端开包", async ({ page }) => {
  // 串联购买、开包动画、详情、历史与刷新，叠加 dev 首次编译后超过默认 30s 单测超时；故单独放宽。
  test.setTimeout(90_000);
  await registerPlayer(page);
  await mockPackList(page, [activePack]);
  await mockOpeningPresentations(page);
  let previewCalls = 0;
  let openCalls = 0;
  let historyCalls = 0;
  let receivedKey: string | undefined;
  await page.route(`**/v1/store/packs/${activePackId}/purchase-preview`, async (route) => {
    previewCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          preview: {
            pack: activePack,
            ruleVersion: "pack/v1",
            cost: activePack.price,
            canPurchase: true,
            unavailableReason: null
          }
        })
      )
    });
  });
  await page.route(`**/v1/packs/${activePackId}/open`, async (route) => {
    openCalls += 1;
    receivedKey = route.request().headers()["idempotency-key"];
    await new Promise((resolve) => setTimeout(resolve, 150));
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(envelope({ opening }))
    });
  });
  await page.route("**/v1/pack-openings?*", async (route) => {
    historyCalls += 1;
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ items: [opening], page: { hasMore: false, nextCursor: null } })
      )
    });
  });
  await page.goto("/packs");
  await page.getByRole("button", { name: "购买并开包" }).click();
  await expect(page.getByRole("heading", { name: "确认购买" })).toBeVisible();
  await expect(page.getByText("本次扣款：500 游戏币")).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认购买并开包" });
  await confirm.click();
  await expect(page.getByRole("button", { name: "正在由服务端开包…" })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "本次开包结果" })).toBeVisible();
  await expect(page.getByRole("button", { name: "跳过动画" })).toBeVisible();
  await page.getByRole("button", { name: "跳过动画" }).click({ force: true });
  await expect(page.getByText("测试火花法师")).toBeVisible();
  await expect(page.getByText("当前市场价：250 游戏币").first()).toBeVisible();
  await page.getByRole("button", { name: "详情" }).first().click();
  await expect(page.getByRole("dialog", { name: "卡牌详情" })).toBeVisible();
  await expect(page.getByText("罕贵度")).toBeVisible();
  await expect(page.getByText("rare")).toBeVisible();
  await expect(page.getByText("暂无本地图片；管理员可按需缓存该印刷的卡图。")).toBeVisible();
  expect(openCalls).toBe(1);
  expect(receivedKey).toMatch(/^[0-9a-f-]{36}$/i);
  expect(previewCalls).toBeGreaterThanOrEqual(1);
  // 卡牌详情 Modal 仍打开，其遮罩（ant-modal-wrap）会拦截后续点击；先关闭再进入开包历史。
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "卡牌详情" })).toHaveCount(0);
  await page.getByRole("link", { name: "查看开包历史" }).first().click();
  await expect(page.getByRole("heading", { name: "开包历史" })).toBeVisible();
  await expect(page.getByText(opening.openedAt)).toBeVisible();
  await page.reload();
  await expect(page.getByText(opening.openedAt)).toBeVisible();
  expect(historyCalls).toBeGreaterThanOrEqual(2);
});

test("余额不足和版本过期由服务端提示，失败不伪造开包结果", async ({ page }) => {
  await registerPlayer(page);
  await mockPackList(page, [activePack]);
  let insufficient = true;
  let openCalls = 0;
  await page.route(`**/v1/store/packs/${activePackId}/purchase-preview`, async (route) => {
    const preview = {
      pack: activePack,
      ruleVersion: "pack/v1",
      cost: activePack.price,
      canPurchase: !insufficient,
      unavailableReason: insufficient ? "insufficient_balance" : null
    };
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ preview }))
    });
  });
  await page.route(`**/v1/packs/${activePackId}/open`, async (route) => {
    openCalls += 1;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify(failure("VERSION_STALE", "补充包规则版本已更新，请重新确认购买"))
    });
  });
  await page.goto("/packs");
  await page.getByRole("button", { name: "购买并开包" }).click();
  await expect(page.getByText("可用余额不足，请先获得更多游戏币。")).toBeVisible();
  await expect(page.getByRole("button", { name: "确认购买并开包" })).toBeDisabled();
  expect(openCalls).toBe(0);
  await page.getByRole("button", { name: "取消" }).click();
  insufficient = false;
  await page.getByRole("button", { name: "购买并开包" }).click();
  const retryConfirm = page.getByRole("button", { name: "确认购买并开包" });
  await expect(retryConfirm).toBeEnabled();
  await retryConfirm.click();
  await expect(page.getByText("补充包规则版本已更新，请重新确认购买")).toBeVisible();
  await expect(page.getByRole("heading", { name: "本次开包结果" })).toHaveCount(0);
  expect(openCalls).toBe(1);
});

test("补充包页覆盖加载、空列表、失败重试和规则版本刷新", async ({ page }) => {
  await registerPlayer(page);
  let state: "loading" | "empty" | "failed" | "v1" | "v2" = "loading";
  await page.route("**/v1/packs", async (route) => {
    if (state === "loading") {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(envelope({ items: [activePack] }))
      });
    }
    if (state === "failed")
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(failure("INTERNAL_ERROR", "补充包暂不可用"))
      });
    const items =
      state === "empty"
        ? []
        : [{ ...activePack, ruleVersion: state === "v2" ? "pack/v2" : "pack/v1" }];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items }))
    });
  });
  await page.goto("/packs");
  await expect(page.locator('[aria-busy="true"]').first()).toBeVisible();
  await expect(page.getByText("测试补充包")).toBeVisible();
  state = "empty";
  await page.reload();
  await expect(page.getByRole("heading", { name: "暂无可公示的补充包" })).toBeVisible();
  state = "failed";
  await page.reload();
  await expect(page.getByRole("heading", { name: "补充包加载失败" })).toBeVisible();
  state = "v2";
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("pack/v2")).toBeVisible();
});
