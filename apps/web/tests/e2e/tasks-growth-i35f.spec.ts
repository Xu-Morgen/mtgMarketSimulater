import { expect, test, type Page } from "@playwright/test";

const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const now = "2026-08-05T08:00:00.000Z";
const userId = "10000000-0000-4000-8000-000000000350";

function envelope(data: unknown) {
  return { ok: true, data, meta: { requestId: "i35f-e2e" } };
}

async function session(page: Page) {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i35f-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          accessToken: "i35f-token",
          user: { id: userId, email: "i35f@example.test", displayName: "I35F 测试玩家", role: "player", createdAt: now }
        })
      )
    })
  );
}

const growthProfile = {
  level: 2,
  title: "资深收藏家",
  totalXp: 200,
  nextLevelXp: 500,
  progressBasisPoints: 0,
  capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 50 },
  peakNetWorth: { amount: 12_000, currency: "GAME_CREDIT" },
  ruleVersion: "level/v1",
  updatedAt: now
};

function instance(input: Partial<{
  id: string;
  definitionId: string;
  period: "daily" | "weekly";
  periodKey: string;
  title: string;
  description: string;
  metricType: "pack.open" | "trade" | "npc.sell" | "collection.value" | "tournament.play" | "set.completion";
  currentValue: number;
  targetAmount: number;
  rewardAmount: number;
  status: "pending" | "claimable" | "claimed";
}>) {
  return {
    id: input.id ?? "task-i35f",
    definitionId: input.definitionId ?? "daily-open-3/v1",
    period: input.period ?? "daily",
    periodKey: input.periodKey ?? "2026-08-05",
    title: input.title ?? "每日开包",
    description: input.description ?? "本日开包 3 次",
    metricType: input.metricType ?? "pack.open",
    currentValue: input.currentValue ?? 0,
    targetAmount: input.targetAmount ?? 3,
    rewardAmount: input.rewardAmount ?? 100,
    status: input.status ?? "pending",
    claimedAt: input.status === "claimed" ? now : null
  };
}

/** 任务中心与等级展示只来自服务端响应；周期键/进度/可领取状态均不在浏览器判定。 */
async function mockTaskCenterCommon(page: Page) {
  await page.route("**/v1/growth", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(growthProfile)) })
  );
  await page.route("**/v1/archive", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          archive: {
            id: "archive-i35f", userId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now,
            balance: { total: { amount: 12_000, currency: "GAME_CREDIT" }, available: { amount: 12_000, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now },
            netWorth: null
          }
        })
      )
    })
  );
  await page.route("**/v1/ledger?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) })
  );
}

test("任务中心：等级卡片、今日/本周任务进度条与可领取状态，服务端周期键只读展示", async ({ page }) => {
  await session(page);
  let centerReads = 0;
  await page.route("**/v1/tasks", (route) => {
    centerReads += 1;
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          daily: [
            instance({ definitionId: "daily-open-3/v1", title: "每日开包", description: "本日开包 3 次", metricType: "pack.open", currentValue: 2, targetAmount: 3, rewardAmount: 100 }),
            instance({ id: "task-sell", definitionId: "daily-sell-1/v1", title: "每日卖出", description: "本日向 NPC 卖出至少一张卡牌", metricType: "npc.sell", currentValue: 1, targetAmount: 1, rewardAmount: 80, status: "claimable" }),
            instance({ definitionId: "daily-trade-10/v1", title: "每日交易", description: "本日完成 10 张卡牌交易（NPC 或玩家间）", metricType: "trade", currentValue: 10, targetAmount: 10, rewardAmount: 100, status: "claimed" })
          ],
          weekly: [
            instance({ period: "weekly", periodKey: "2026-W32", definitionId: "weekly-tournament-3/v1", title: "每周参赛", description: "本周完成 3 场赛事结算", metricType: "tournament.play", currentValue: 1, targetAmount: 3, rewardAmount: 300 })
          ],
          pendingRewardCount: 1,
          period: { day: "2026-08-05", week: "2026-W32" }
        })
      )
    });
  });
  await mockTaskCenterCommon(page);
  await page.goto("/tasks");
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  // 等级卡片：等级、称号、经验与已解锁能力只展示服务端档案。
  await expect(page.getByText("资深收藏家").first()).toBeVisible();
  await expect(page.getByText("Lv.2")).toBeVisible();
  await expect(page.getByText("NPC 每日交易额度 ×1")).toBeVisible();
  await expect(page.getByText("单次批量开包上限 50 包")).toBeVisible();
  await expect(page.getByRole("img", { name: "经验进度 0%" })).toBeVisible();
  // 可领取横幅与任务条目：进度条只读服务端 currentValue/targetAmount。
  await expect(page.getByText("有 1 项任务奖励可领取。")).toBeVisible();
  await expect(page.getByRole("heading", { name: "今日任务" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "本周任务" })).toBeVisible();
  await expect(page.getByText("每日开包")).toBeVisible();
  await expect(page.getByRole("img", { name: /任务进度/ }).first()).toBeVisible();
  await expect(page.getByText("2 / 3", { exact: true })).toBeVisible();
  // 状态徽标：可领取/已领取/进行中只取服务端 status。
  await expect(page.getByText("可领取", { exact: true })).toBeVisible();
  await expect(page.getByText("已领取", { exact: true })).toBeVisible();
  await expect(page.getByText("进行中", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "领取 80 游戏币" })).toBeVisible();
  await expect(page.getByRole("button", { name: "奖励已领取" })).toBeDisabled();
  // 服务端周期键只读展示（浏览器不用本地日期推导）。
  await expect(page.getByText("服务端周期：日 2026-08-05 · 周 2026 年第 32 周")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
  expect(centerReads).toBe(2);
});

test("任务领取：二次确认后只投递一次，成功横幅展示服务端入账并刷新任务与首页", async ({ page }) => {
  await session(page);
  let tasksState: "claimable" | "claimed" = "claimable";
  await page.route("**/v1/tasks", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          daily: [
            instance({ id: "task-sell", definitionId: "daily-sell-1/v1", title: "每日卖出", description: "本日向 NPC 卖出至少一张卡牌", metricType: "npc.sell", currentValue: 1, targetAmount: 1, rewardAmount: 80, status: tasksState })
          ],
          weekly: [],
          pendingRewardCount: tasksState === "claimable" ? 1 : 0,
          period: { day: "2026-08-05", week: "2026-W32" }
        })
      )
    })
  );
  await mockTaskCenterCommon(page);
  let claimCalls = 0;
  const claimKeys: string[] = [];
  await page.route("**/v1/tasks/task-sell/claim", async (route) => {
    claimCalls += 1;
    claimKeys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({});
    await new Promise((resolve) => setTimeout(resolve, 150));
    tasksState = "claimed";
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          instanceId: "task-sell",
          status: "claimed",
          reward: { amount: 80, currency: "GAME_CREDIT" },
          balance: { amount: 12_080, currency: "GAME_CREDIT" }
        })
      )
    });
  });
  await page.goto("/tasks");
  await expect(page.getByRole("button", { name: "领取 80 游戏币" })).toBeVisible();
  await page.getByRole("button", { name: "领取 80 游戏币" }).click();
  await expect(page.getByRole("dialog", { name: "确认领取任务奖励" })).toBeVisible();
  await page.getByRole("button", { name: "确认" }).dblclick();
  // 二次确认弹窗关闭、只投递一次；成功横幅只展示服务端入账结果。
  await expect(page.getByRole("dialog", { name: "确认领取任务奖励" })).not.toBeVisible();
  await expect(page.getByText("已领取奖励 80 游戏币，当前可用余额 12,080 游戏币（由服务器入账）。")).toBeVisible();
  await expect(page.getByRole("button", { name: "奖励已领取" })).toBeDisabled();
  expect(claimCalls).toBe(1);
  expect(claimKeys[0]).toMatch(/^[0-9a-f-]{36}$/i);
});

test("任务领取失败与空态：错误横幅可重试，无任务定义显示空态", async ({ page }) => {
  await session(page);
  await mockTaskCenterCommon(page);
  await page.route("**/v1/tasks", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({ daily: [], weekly: [], pendingRewardCount: 0, period: { day: "2026-08-05", week: "2026-W32" } })
      )
    })
  );
  let claimCalls = 0;
  await page.route("**/v1/tasks/task-sell/claim", async (route) => {
    claimCalls += 1;
    return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT", message: "该任务奖励已领取" }, meta: { requestId: "i35f-failure" } }) });
  });
  await page.goto("/tasks");
  await expect(page.getByText("当前没有可领取的任务奖励；继续完成服务端记录的目标即可。")).toBeVisible();
  await expect(page.getByText("今日暂无任务")).toBeVisible();
  expect(claimCalls).toBe(0);
});

test("玩家首页：等级卡片、任务中心入口与服务端待办「领取任务中心奖励」联动", async ({ page }) => {
  await session(page);
  await page.route("**/v1/growth", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(growthProfile)) })
  );
  await page.route("**/v1/archive", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          archive: {
            id: "archive-i35f", userId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now,
            balance: { total: { amount: 12_000, currency: "GAME_CREDIT" }, available: { amount: 12_000, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now },
            netWorth: null
          }
        })
      )
    })
  );
  await page.route("**/v1/ledger?*", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [], page: { total: 0, hasMore: false, nextCursor: null } })) })
  );
  await page.route("**/v1/dashboard", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(
        envelope({
          overview: {
            balance: { total: { amount: 12_000, currency: "GAME_CREDIT" }, available: { amount: 12_000, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now },
            netWorth: { amount: 12_000, currency: "GAME_CREDIT" },
            collection: { distinctSkuCount: 0, totalCardCount: 0, marketValue: { amount: 0, currency: "GAME_CREDIT" }, unpricedSkuCount: 0 },
            dailyWorkFunding: {
              naturalDate: "2026-08-05", timezone: "Asia/Shanghai", status: "claimed", amount: { amount: 1000, currency: "GAME_CREDIT" },
              ruleVersion: "daily-work-funds/v1", openedAt: now, nextEligibleAt: "2026-08-06T16:00:00.000Z",
              claim: { id: "daily-i35f", naturalDate: "2026-08-05", timezone: "Asia/Shanghai", amount: { amount: 1000, currency: "GAME_CREDIT" }, ruleVersion: "daily-work-funds/v1", claimedAt: now }
            },
            todayTournaments: { availableCount: 0, registeredCount: 0, settlingCount: 0, settledCount: 0 },
            marketIndex: { referenceIndex: null, gameIndex: null, quotedSkus: 0, capturedAt: now },
            todos: [
              { id: "claim_task_rewards", label: "领取任务中心奖励", href: "/tasks" },
              { id: "acquire_cards", label: "获得第一张卡牌", href: "/packs" }
            ],
            capturedAt: now
          }
        })
      )
    })
  );
  await page.goto("/dashboard");
  // 等级与声望区块：只展示服务端等级档案。
  await expect(page.getByRole("heading", { name: "等级与声望" })).toBeVisible();
  await expect(page.getByText("资深收藏家").first()).toBeVisible();
  await expect(page.getByText("Lv.2")).toBeVisible();
  // 今日循环入口：任务中心按钮跳转 /tasks。
  await expect(page.getByRole("link", { name: "查看任务中心" })).toBeVisible();
  // 服务端待办联动：有可领取任务奖励时显示「领取任务中心奖励」并跳转任务中心。
  await expect(page.getByRole("link", { name: "领取任务中心奖励" })).toHaveAttribute("href", "/tasks");
  await page.getByRole("link", { name: "领取任务中心奖励" }).click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole("heading", { name: "任务中心" })).toBeVisible();
});
