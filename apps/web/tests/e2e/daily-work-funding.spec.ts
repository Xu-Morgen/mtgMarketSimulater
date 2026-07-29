import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-29T08:00:00.000Z";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const userId = "10000000-0000-4000-8000-00000000023f";

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i23f-e2e" } }; }
function failure(code: string, message: string) { return { ok: false, error: { code, message }, meta: { requestId: "i23f-failure" } }; }

function status(input: Partial<{ naturalDate: string; timezone: string; state: "available" | "claimed" | "not_open"; nextEligibleAt: string; claim: object | null }> = {}) {
  const naturalDate = input.naturalDate ?? "2026-07-29";
  const timezone = input.timezone ?? "Asia/Shanghai";
  const amount = { amount: 1000, currency: "GAME_CREDIT" };
  return {
    naturalDate, timezone, status: input.state ?? "available", amount, ruleVersion: "daily-work-funds/v1",
    openedAt: "2026-07-28T16:00:00.000Z", nextEligibleAt: input.nextEligibleAt ?? "2026-07-29T16:00:00.000Z",
    claim: input.claim ?? (input.state === "claimed" ? { id: "daily-claim-i23f", naturalDate, timezone, amount, ruleVersion: "daily-work-funds/v1", claimedAt: now } : null)
  };
}

async function recoverPlayerSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "daily-work-funding-e2e-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "daily-work-funding-e2e-token", user: { id: userId, email: "daily-work-funding@example.test", displayName: "每日资金测试玩家", role: "player", createdAt: now } })) }));
}

async function mockDashboard(page: Page, ledgerReason = "initial_funding"): Promise<void> {
  await page.route("**/v1/archive", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ archive: { id: "archive-i23f", userId, initialFundingRuleVersion: "initial-funding/v1", createdAt: now, balance: { total: { amount: 11_000, currency: "GAME_CREDIT" }, available: { amount: 11_000, currency: "GAME_CREDIT" }, frozen: { amount: 0, currency: "GAME_CREDIT" }, updatedAt: now }, netWorth: null } })) }));
  await page.route("**/v1/ledger?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{ id: `ledger-${ledgerReason}`, direction: "credit", amount: { amount: 1000, currency: "GAME_CREDIT" }, balanceAfter: { amount: 11_000, currency: "GAME_CREDIT" }, reason: ledgerReason, occurredAt: now }], page: { total: 1, hasMore: false, nextCursor: null } })) }));
}

test("每日工作资金以服务端资格领取，双击只提交一次并刷新账本", async ({ page }) => {
  await mockDashboard(page, "daily_work_funding");
  let currentStatus = status();
  let postCalls = 0;
  const keys: string[] = [];
  await page.route("**/v1/daily-work-funding", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ status: currentStatus })) }));
  await page.route("**/v1/daily-work-funding/claim", async (route) => {
    postCalls += 1;
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    expect(route.request().postDataJSON()).toEqual({});
    currentStatus = status({ state: "claimed" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ funding: currentStatus.claim })) });
  });
  await recoverPlayerSession(page);
  await page.goto("/dashboard");
  await expect(page.getByText("服务端日期：2026-07-29（Asia/Shanghai）")).toBeVisible();
  await expect(page.getByRole("button", { name: "领取 1,000 游戏币" })).toBeEnabled();
  await page.getByRole("button", { name: "领取 1,000 游戏币" }).dblclick();
  await expect(page.getByRole("button", { name: "今日已领取" })).toBeDisabled();
  await expect(page.getByText("领取记录：1,000 游戏币")).toBeVisible();
  await expect(page.getByRole("cell", { name: "每日工作资金" })).toBeVisible();
  expect(postCalls).toBe(1);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/i);
});

test("已领取状态只显示服务端记录，不再投递领取请求", async ({ page }) => {
  await mockDashboard(page, "daily_work_funding");
  let postCalls = 0;
  await page.route("**/v1/daily-work-funding", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ status: status({ state: "claimed" }) })) }));
  await page.route("**/v1/daily-work-funding/claim", async (route) => { postCalls += 1; await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify(failure("UNEXPECTED", "不应调用领取接口")) }); });
  await recoverPlayerSession(page);
  await page.goto("/dashboard");
  await expect(page.getByText("今日已领取").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "今日已领取" })).toBeDisabled();
  await expect(page.getByText("下一次可领取：")).toBeVisible();
  expect(postCalls).toBe(0);
});

test("跨日冲突后重新读取服务端日期与时区，不使用浏览器本地日期", async ({ page }) => {
  await mockDashboard(page);
  let currentStatus = status({ naturalDate: "2026-07-29", timezone: "Asia/Shanghai" });
  let statusCalls = 0;
  await page.route("**/v1/daily-work-funding", async (route) => {
    statusCalls += 1;
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ status: currentStatus })) });
  });
  await page.route("**/v1/daily-work-funding/claim", async (route) => {
    currentStatus = status({ naturalDate: "2026-07-30", timezone: "America/New_York", nextEligibleAt: "2026-07-31T04:00:00.000Z" });
    await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(failure("RESOURCE_CONFLICT", "服务器自然日已切换，请重新确认资格")) });
  });
  await recoverPlayerSession(page);
  await page.goto("/dashboard");
  await expect(page.getByRole("button", { name: "领取 1,000 游戏币" })).toBeEnabled();
  await page.getByRole("button", { name: "领取 1,000 游戏币" }).click();
  await expect(page.getByText("服务器自然日已切换，请重新确认资格")).toBeVisible();
  await expect(page.getByText("服务端日期：2026-07-30（America/New_York）")).toBeVisible();
  await expect(page.getByText("下一次可领取：")).toBeVisible();
  expect(statusCalls).toBeGreaterThanOrEqual(2);
});
