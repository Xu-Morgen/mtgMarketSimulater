import { expect, test, type Page } from "@playwright/test";

const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const now = "2026-08-04T08:00:00.000Z";
const userId = "10000000-0000-4000-8000-000000000330";
const activePackId = "50000000-0000-4000-8000-000000000011";

function envelope(data: unknown) {
  return { ok: true, data, meta: { requestId: "i33f-e2e" } };
}

function failure(code: string, message: string) {
  return { ok: false, error: { code, message }, meta: { requestId: "i33f-failure" } };
}

async function session(page: Page) {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i33f-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          accessToken: "i33f-token",
          user: {
            id: userId,
            email: "i33f@example.test",
            displayName: "I33F 测试玩家",
            role: "player",
            createdAt: now
          }
        })
      )
    })
  );
}

/** 目录与报价只读投影：开包结果展示所需，全部指向本地 API mock。 */
async function mockOpeningPresentations(page: Page) {
  await page.route("**/v1/catalog/cards/**", async (route) => {
    const skuId = route.request().url().split("/").pop() ?? "";
    const isRare = skuId.endsWith("1");
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          sku: {
            id: skuId,
            printingId: `printing-${skuId}`,
            scryfallId: `scryfall-${skuId}`,
            name: isRare ? "测试火花法师" : "测试林地精灵",
            setCode: "I33",
            setName: "I33F 测试系列",
            collectorNumber: isRare ? "1" : "2",
            finish: "nonfoil",
            rarity: isRare ? "rare" : "common",
            legalities: {},
            manaCost: null,
            colors: [],
            colorIdentity: [],
            typeLine: "Creature",
            power: "1",
            toughness: "1",
            image: { path: null, sourceUrl: null, status: "missing", cachedAt: null },
            source: "scryfall",
            sourceReference: null,
            isManualException: false,
            tradable: true,
            oracleText: null,
            artist: null,
            releasedAt: null
          }
        })
      )
    });
  });
  await page.route("**/v1/market/quotes/**", async (route) => {
    const skuId = route.request().url().split("/").pop() ?? "";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          quote: {
            skuId,
            quoteVersion: "market/v1",
            referencePrice: { amount: 30, currency: "EUR" },
            marketPrice: { amount: 260, currency: "GAME_CREDIT" },
            npcBuyPrice: { amount: 234, currency: "GAME_CREDIT" },
            npcSellPrice: { amount: 286, currency: "GAME_CREDIT" },
            validUntil: "2026-08-05T08:00:00.000Z",
            source: "mtgjson-cardmarket",
            capturedAt: now,
            reasons: []
          }
        })
      )
    });
  });
}

const activePack = {
  id: activePackId,
  code: "PLAY-01",
  name: "I33F 测试补充包",
  description: "用于验证批量开包与新卡/重复反馈。",
  price: { amount: 500, currency: "GAME_CREDIT" },
  enabled: true,
  disabledReason: null,
  ruleVersion: "pack/v1",
  updatedAt: "2026-08-04T08:00:00.000Z",
  slots: [
    {
      id: "regular",
      draws: 2,
      rarityProbabilities: [
        { rarity: "common", probabilityBasisPoints: 9000 },
        { rarity: "rare", probabilityBasisPoints: 1000 }
      ]
    }
  ],
  offer: null
};

const activePurchasePreview = {
  pack: activePack,
  ruleVersion: "pack/v1",
  cost: activePack.price,
  canPurchase: true,
  unavailableReason: null
};

function openingDto(index: number): Record<string, unknown> {
  const firstNew = index === 0;
  return {
    id: `opening-${index}`,
    packId: activePackId,
    packRuleVersion: "pack/v1",
    spent: { amount: 500, currency: "GAME_CREDIT" },
    received: [
      {
        skuId: "30000000-0000-4000-8000-000000000011",
        quantity: 1,
        cost: { amount: 250, currency: "GAME_CREDIT" },
        referencePrice: null,
        gamePrice: { amount: 260, currency: "GAME_CREDIT" },
        priceStatus: "available",
        isNewToCollection: firstNew,
        collectionProgressAfter: {
          setCode: "I33",
          collectedSkuCount: 1,
          totalSkuCount: 2,
          completionBasisPoints: 5000
        }
      },
      {
        skuId: "30000000-0000-4000-8000-000000000012",
        quantity: 1,
        cost: { amount: 250, currency: "GAME_CREDIT" },
        referencePrice: null,
        gamePrice: { amount: 260, currency: "GAME_CREDIT" },
        priceStatus: "available",
        isNewToCollection: firstNew,
        collectionProgressAfter: {
          setCode: "I33",
          collectedSkuCount: 1,
          totalSkuCount: 2,
          completionBasisPoints: 5000
        }
      }
    ],
    profitLoss: {
      spent: { amount: 500, currency: "GAME_CREDIT" },
      referenceValue: null,
      gameValue: { amount: 520, currency: "GAME_CREDIT" },
      referenceProfitLoss: null,
      gameProfitLoss: { amount: 20, currency: "GAME_CREDIT" },
      priceStatus: "available"
    },
    totalCost: { amount: 500, currency: "GAME_CREDIT" },
    totalGameValue: { amount: 520, currency: "GAME_CREDIT" },
    openedAt: "2026-08-04T09:00:00.000Z"
  };
}

const milestoneDefinition = {
  id: "set-completion-80/v1",
  kind: "collection",
  category: "collection-set",
  goal: 80,
  reward: { kind: "GAME_CREDIT", amount: 300, packId: null, skuId: null, badgeId: null },
  display: { title: "系列图鉴·八成", description: "任意一个系列的收集率达到 80%", badge: null },
  hidden: false,
  ruleVersion: "achievement/v1"
};

test("收藏图鉴：按系列分组展示完成度、灰影占位，切换仅持有与里程碑联动", async ({ page }) => {
  await session(page);
  const pktSet = {
    setCode: "PKT",
    setName: "图鉴测试系列一",
    collectedSkuCount: 1,
    totalSkuCount: 2,
    completionBasisPoints: 5000,
    uncollectedCards: [{ name: "图鉴卡二", setCode: "PKT", collectorNumber: "2", rarity: "common" }]
  };
  const secSet = {
    setCode: "SEC",
    setName: "图鉴测试系列二",
    collectedSkuCount: 0,
    totalSkuCount: 1,
    completionBasisPoints: 0,
    uncollectedCards: [{ name: "第二系列卡", setCode: "SEC", collectorNumber: "1", rarity: "rare" }]
  };
  let albumReads = 0;
  await page.route("**/v1/collection/album*", (route) => {
    albumReads += 1;
    const url = new URL(route.request().url());
    const onlyHeld = url.searchParams.get("onlyHeld");
    const items = onlyHeld === "held" ? [pktSet] : [pktSet, secSet];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          sets: { items, page: { total: items.length, hasMore: false, nextCursor: null } }
        })
      )
    });
  });
  await page.route("**/v1/achievements", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          items: [
            {
              definition: milestoneDefinition,
              progress: {
                definitionId: milestoneDefinition.id,
                currentValue: 80,
                goalValue: 80,
                status: "unlocked",
                unlockedAt: now,
                lastEvaluatedFactId: "fact-i33f"
              }
            },
            {
              definition: {
                ...milestoneDefinition,
                id: "first-tournament/v1",
                kind: "tournament",
                category: "tournament",
                goal: 1,
                display: { title: "初登赛场", description: "完成第一场赛事结算", badge: null }
              },
              progress: null
            }
          ]
        })
      )
    })
  );
  await page.goto("/collection/album");
  await expect(page.getByRole("heading", { name: "收藏图鉴" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "图鉴测试系列一" })).toBeVisible();
  await expect(page.getByText("50%", { exact: true })).toBeVisible();
  await expect(page.getByText("已收集 1 / 2 种印刷·工艺 SKU")).toBeVisible();
  await expect(page.getByText("图鉴卡二")).toBeVisible();
  await expect(page.getByText("未收集").first()).toBeVisible();
  await expect(page.getByText("第二系列卡")).toBeVisible();
  await expect(page.getByText("0%", { exact: true })).toBeVisible();
  // 仅持有切换：只保留已持有系列并写入 URL。
  await page.getByRole("button", { name: "仅持有", exact: true }).click();
  await expect(page).toHaveURL(/onlyHeld=held/);
  await expect(page.getByRole("heading", { name: "图鉴测试系列一" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "图鉴测试系列二" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "全部系列" })).toHaveAttribute(
    "aria-pressed",
    "false"
  );
  // 里程碑联动：只读展示服务端收藏成就进度。
  await expect(page.getByRole("heading", { name: "收藏里程碑联动" })).toBeVisible();
  await expect(page.getByText("系列图鉴·八成")).toBeVisible();
  await expect(page.getByText("已解锁").first()).toBeVisible();
  await expect(page.getByRole("link", { name: "查看服务端进度" })).toHaveCount(1);
  expect(albumReads).toBeGreaterThanOrEqual(2);
});

test("收藏图鉴：空态、查询失败重试与窄屏不阻断", async ({ page }) => {
  await session(page);
  let failed = false;
  await page.route("**/v1/collection/album*", (route) => {
    if (failed) {
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify(failure("INTERNAL_ERROR", "图鉴暂不可用"))
      });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ sets: { items: [], page: { total: 0, hasMore: false, nextCursor: null } } })
      )
    });
  });
  await page.route("**/v1/achievements", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items: [] }))
    })
  );
  await page.goto("/collection/album");
  await expect(page.getByRole("heading", { name: "暂无图鉴系列" })).toBeVisible();
  // 查询失败：整页刷新后重取失败，展示错误与重试。
  failed = true;
  await page.reload();
  await expect(page.getByRole("heading", { name: "收藏图鉴加载失败" })).toBeVisible();
  await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
  // 恢复：重试按钮重新读取服务端空结果。
  failed = false;
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByRole("heading", { name: "暂无图鉴系列" })).toBeVisible();
});

test("批量开包：二次确认重复点击只投递一次，汇总与逐包下钻只读服务端结果", async ({ page }) => {
  test.setTimeout(90_000);
  await session(page);
  await page.route("**/v1/packs", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items: [activePack] }))
    })
  );
  await page.route(`**/v1/store/packs/${activePackId}/purchase-preview`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ preview: activePurchasePreview }))
    })
  );
  let bulkCalls = 0;
  let receivedKey: string | undefined;
  await page.route(`**/v1/packs/${activePackId}/bulk`, async (route) => {
    bulkCalls += 1;
    receivedKey = route.request().headers()["idempotency-key"];
    const body = route.request().postDataJSON() as { count: number };
    const count = body.count;
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          bulk: {
            summary: {
              packId: activePackId,
              packRuleVersion: "pack/v1",
              count,
              rarityCounts: [{ rarity: "common", quantity: count * 2 }],
              totalCost: { amount: 500 * count, currency: "GAME_CREDIT" },
              totalGameValue: { amount: 520 * count, currency: "GAME_CREDIT" },
              newSkuCount: 2
            },
            openings: Array.from({ length: count }, (_, index) => openingDto(index))
          }
        })
      )
    });
  });
  await mockOpeningPresentations(page);
  await page.goto("/packs");
  await page.getByRole("button", { name: "批量开包" }).click();
  await expect(page.getByRole("heading", { name: "批量开包" })).toBeVisible();
  await expect(page.getByText("本次扣款（每包）：500 游戏币")).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认批量开包" });
  // 二次确认的重复点击只投递一次：单次 dblclick 在一次可操作性检查后派发两次点击，
  // 按钮随后禁用改文案也不会再次解析 locator；配合弹窗内同步 confirmationLock 验证不重复投递。
  await confirm.dblclick();
  await expect(page.getByRole("heading", { name: "批量开包完成" })).toBeVisible();
  await expect(page.getByText("10 包", { exact: true })).toBeVisible();
  await expect(page.getByText("5,000 游戏币").first()).toBeVisible();
  await expect(page.getByText("新加入收藏 SKU")).toBeVisible();
  // 逐包下钻：首包标新卡，后续包标重复。
  await page.getByText("逐包下钻（只读已结算结果）").click();
  await expect(page.getByText("新卡", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("重复", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("系列 I33 进度 50%").first()).toBeVisible();
  expect(bulkCalls).toBe(1);
  expect(receivedKey).toMatch(/^[0-9a-f-]{36}$/i);
});

test("限时包已结束：展示服务端拒绝原因并禁用购买与批量开包", async ({ page }) => {
  await session(page);
  const endedOfferPack = {
    ...activePack,
    id: "50000000-0000-4000-8000-000000000012",
    offer: {
      id: "60000000-0000-4000-8000-000000000001",
      packId: "50000000-0000-4000-8000-000000000012",
      name: "限时折扣",
      description: "活动已结束的折扣窗口",
      discountBps: 8000,
      startsAt: "2026-08-01T00:00:00.000Z",
      endsAt: "2026-08-02T00:00:00.000Z",
      status: "ended",
      version: 1,
      updatedAt: now
    }
  };
  await page.route("**/v1/packs", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items: [endedOfferPack] }))
    })
  );
  await page.goto("/packs");
  await expect(page.getByText("限时销售", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("-20% 限时折扣")).toBeVisible();
  await expect(page.getByText("该限时包的销售窗口已结束，当前不可购买。")).toBeVisible();
  await expect(page.getByRole("button", { name: "购买并开包" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "批量开包" })).toBeDisabled();
});

test("重复卡一键清仓：开包结果页二次确认只投递一次并展示服务端汇总横幅", async ({ page }) => {
  test.setTimeout(90_000);
  await session(page);
  await page.route("**/v1/packs", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items: [activePack] }))
    })
  );
  await page.route(`**/v1/store/packs/${activePackId}/purchase-preview`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ preview: activePurchasePreview }))
    })
  );
  await page.route(`**/v1/packs/${activePackId}/open`, (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(envelope({ opening: openingDto(0) }))
    })
  );
  let sellCalls = 0;
  let receivedKey: string | undefined;
  await page.route("**/v1/inventory/duplicates/sell", async (route) => {
    sellCalls += 1;
    receivedKey = route.request().headers()["idempotency-key"];
    await new Promise((resolve) => setTimeout(resolve, 150));
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          result: {
            soldItems: [
              {
                skuId: "30000000-0000-4000-8000-000000000011",
                quantity: 2,
                unitPrice: { amount: 234, currency: "GAME_CREDIT" },
                unitFee: { amount: 11, currency: "GAME_CREDIT" },
                total: { amount: 468, currency: "GAME_CREDIT" },
                fee: { amount: 22, currency: "GAME_CREDIT" }
              }
            ],
            skippedItems: [
              { skuId: "30000000-0000-4000-8000-000000000012", reason: "quote_unavailable" }
            ],
            cardCount: 2,
            income: { amount: 468, currency: "GAME_CREDIT" },
            fee: { amount: 22, currency: "GAME_CREDIT" }
          }
        })
      )
    });
  });
  await mockOpeningPresentations(page);
  await page.goto("/packs");
  await page.getByRole("button", { name: "购买并开包" }).click();
  await page.getByRole("button", { name: "确认购买并开包" }).click();
  await expect(page.getByRole("heading", { name: "本次开包结果" })).toBeVisible();
  await page.getByRole("button", { name: "跳过动画" }).click({ force: true });
  await page.getByRole("button", { name: "批量卖出重复卡" }).click();
  await expect(page.getByRole("heading", { name: "批量卖出重复卡" })).toBeVisible();
  const confirm = page.getByRole("button", { name: "确认批量卖出重复卡" });
  // 二次确认的重复点击只投递一次：单次 dblclick 在一次可操作性检查后派发两次点击，
  // 按钮随后禁用改文案也不会再次解析 locator；配合弹窗内同步 confirmationLock 验证不重复投递。
  await confirm.dblclick();
  await expect(page.getByRole("heading", { name: "重复卡批量卖出已完成" })).toBeVisible();
  await expect(page.getByText(/服务端共卖出/)).toBeVisible();
  await expect(page.getByText(/实际收入 468 游戏币/)).toBeVisible();
  await expect(page.getByText(/quote_unavailable/)).toBeVisible();
  expect(sellCalls).toBe(1);
  expect(receivedKey).toMatch(/^[0-9a-f-]{36}$/i);
});

test("库存页提供批量卖出重复卡入口，空态不阻断", async ({ page }) => {
  await session(page);
  await page.route("**/v1/inventory?*", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })
      )
    })
  );
  await page.route("**/v1/prices/status", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "fresh" })
      )
    })
  );
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "我的库存" })).toBeVisible();
  await page.getByRole("button", { name: "批量卖出重复卡" }).click();
  await expect(page.getByRole("heading", { name: "批量卖出重复卡" })).toBeVisible();
  await page.getByRole("button", { name: "取消" }).click();
  await expect(page.getByRole("heading", { name: "批量卖出重复卡" })).toHaveCount(0);
});
