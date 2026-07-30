import { expect, test, type Page } from "@playwright/test";

const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const now = "2026-07-30T08:00:00.000Z";
const definitionId = "first-tournament/v1";

function envelope(data: unknown) {
  return { ok: true, data, meta: { requestId: "i26f-e2e" } };
}

const definition = {
  id: definitionId,
  kind: "tournament",
  category: "tournament",
  goal: 1,
  reward: { kind: "GAME_CREDIT", amount: 200, packId: null, skuId: null, badgeId: null },
  display: { title: "初登赛场", description: "完成你的第一场赛事结算", badge: null },
  hidden: false,
  ruleVersion: "achievement/v1"
} as const;

const unlockedProgress = {
  definitionId,
  currentValue: 1,
  goalValue: 1,
  status: "unlocked",
  unlockedAt: now,
  lastEvaluatedFactId: "fact-i26f"
} as const;

async function session(page: Page) {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i26f-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          accessToken: "i26f-token",
          user: {
            id: "10000000-0000-4000-8000-000000000260",
            email: "achievements@example.test",
            displayName: "成就测试玩家",
            role: "player",
            createdAt: now
          }
        })
      )
    })
  );
}

test("空成就列表与玩家导航可读", async ({ page }) => {
  await page.route("**/v1/achievements", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items: [] }))
    })
  );
  await session(page);
  await page.goto("/achievements");
  await expect(page.getByRole("heading", { name: "成就与收藏里程碑" })).toBeVisible();
  await expect(page.getByText("暂未配置可展示成就")).toBeVisible();
  await expect(page.getByRole("link", { name: "成就" })).toBeVisible();
});

test("重复刷新只读取同一服务端解锁与自动发放状态，不会由浏览器重复发奖", async ({ page }) => {
  let overviewReads = 0;
  let writes = 0;
  await page.route("**/v1/achievements", (route) => {
    overviewReads += 1;
    if (route.request().method() !== "GET") writes += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items: [{ definition, progress: unlockedProgress }] }))
    });
  });
  await page.route("**/v1/achievements/detail**", (route) => {
    if (route.request().method() !== "GET") writes += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          definition,
          progress: unlockedProgress,
          unlock: {
            definitionId,
            source: {
              type: "tournament.settled",
              factId: "fact-i26f",
              aggregateId: "registration-i26f"
            },
            ruleVersion: "achievement/v1",
            unlockedAt: now,
            reward: definition.reward,
            rewardStatus: "granted",
            rewardCorrelationId: "achievement-reward:user:first-tournament/v1"
          }
        })
      )
    });
  });
  await session(page);
  await page.goto("/achievements");
  await expect(page.getByText("已解锁").first()).toBeVisible();
  await expect(page.getByText("进度：1 / 1")).toBeVisible();
  await page.getByRole("link", { name: "查看服务端详情与来源" }).click();
  await expect(page.getByText("已由服务端发放（无需领取）")).toBeVisible();
  await expect(page.getByText("fact-i26f")).toBeVisible();
  await expect(page.getByRole("link", { name: "查看关联赛事与历史" })).toHaveAttribute(
    "href",
    "/tournaments"
  );
  await expect(page.getByRole("link", { name: "查看账本流水" })).toHaveAttribute(
    "href",
    "/dashboard"
  );
  await page.reload();
  await expect(page.getByText("已由服务端发放（无需领取）")).toBeVisible();
  expect(overviewReads).toBe(1);
  expect(writes).toBe(0);
});

test("奖励风控拦截和收藏来源均保持服务端事实并可跳转", async ({ page }) => {
  const collectionDefinition = {
    ...definition,
    id: "collection-10/v1",
    kind: "collection" as const,
    category: "collection",
    goal: 10,
    display: { title: "收藏起步", description: "持有 10 种不同卡牌 SKU", badge: null }
  };
  const progress = {
    ...unlockedProgress,
    definitionId: collectionDefinition.id,
    currentValue: 10,
    goalValue: 10
  };
  await page.route("**/v1/achievements", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items: [{ definition: collectionDefinition, progress }] }))
    })
  );
  await page.route("**/v1/achievements/detail**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          definition: collectionDefinition,
          progress,
          unlock: {
            definitionId: collectionDefinition.id,
            source: { type: "collection", factId: "fact-collection", aggregateId: "collection-10" },
            ruleVersion: "achievement/v1",
            unlockedAt: now,
            reward: collectionDefinition.reward,
            rewardStatus: "blocked",
            rewardCorrelationId: "achievement-reward:user:collection-10/v1"
          }
        })
      )
    })
  );
  await session(page);
  await page.goto("/achievements");
  await page.getByRole("link", { name: "查看服务端详情与来源" }).click();
  await expect(page.getByText("已解锁，但奖励被服务端风控拦截")).toBeVisible();
  await expect(page.getByRole("link", { name: "查看收藏与库存" })).toHaveAttribute(
    "href",
    "/inventory"
  );
});
