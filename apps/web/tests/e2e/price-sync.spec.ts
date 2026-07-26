import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-26T08:00:00.000Z";
const jobId = "71000000-0000-4000-8000-000000000001";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const successRun = {
  id: "61000000-0000-4000-8000-000000000001", sourceVersion: "5.3.0+fixture", pricesChecksumSha256: "a".repeat(64), mappingChecksumSha256: "b".repeat(64),
  status: "succeeded", mappedSkus: 12, pricedSkus: 9, unpricedSkus: 2, mappingFailedSkus: 1, failureReason: null, startedAt: now, completedAt: now
};
const failedRun = { ...successRun, id: "61000000-0000-4000-8000-000000000002", sourceVersion: "unavailable", status: "failed", mappedSkus: 0, pricedSkus: 0, unpricedSkus: 0, mappingFailedSkus: 0, failureReason: "MTGJSON AllPricesToday 下载失败：HTTP 503" };

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i13f-e2e" } }; }

async function allowFixtureSessionRecovery(page: Page): Promise<void> {
  // 刷新接口由路由桩响应；该可读 CSRF cookie 让新页面加载时真的走恢复会话分支。
  await page.context().addCookies([{ name: "mtg_csrf", value: "price-sync-e2e-csrf", url: webBaseUrl }]);
}

async function loginAdmin(page: Page): Promise<void> {
  await page.route("**/v1/auth/login", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({
    accessToken: "admin-price-sync-fixture-token",
    user: { id: "10000000-0000-4000-8000-000000000001", email: "admin-e2e@example.test", displayName: "E2E 管理员", role: "admin", createdAt: now }
  })) }));
  await page.goto("/login");
  await page.getByLabel("邮箱").fill("admin-price-sync-fixture@example.test");
  await page.getByRole("textbox", { name: "密码" }).fill("fixture-password-123");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

test("管理员可查看失败快照、校验和、映射统计和任务摘要，并主动刷新当日价格", async ({ page }) => {
  await loginAdmin(page);
  let submitted = 0; let idempotencyKey: string | null = null;
  await page.route("**/v1/admin/prices/sync", async (route) => {
    if (route.request().method() === "POST") {
      submitted += 1; idempotencyKey = route.request().headers()["idempotency-key"] ?? null;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ id: jobId, type: "prices.sync", status: "pending", attempt: 0, maxAttempts: 3, uniqueKey: "prices.sync:fixture", scheduledAt: now, lockedUntil: null, lastError: null, updatedAt: now })) });
    }
    const currentJob = submitted > 0
      ? { id: jobId, type: "prices.sync", status: "pending", attempt: 0, maxAttempts: 3, uniqueKey: "prices.sync:fixture", scheduledAt: now, lockedUntil: null, lastError: null, updatedAt: now }
      : { id: jobId, type: "prices.sync", status: "failed", attempt: 1, maxAttempts: 3, uniqueKey: "prices.sync:fixture", scheduledAt: now, lockedUntil: null, lastError: failedRun.failureReason, updatedAt: now };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ latestSuccessful: successRun, current: failedRun, currentJob })) });
  });
  await page.getByRole("link", { name: "价格同步" }).click();
  await expect(page.getByRole("heading", { name: "价格同步状态" })).toBeVisible();
  await expect(page.getByText("MTGJSON AllPricesToday 下载失败：HTTP 503").first()).toBeVisible();
  await expect(page.getByText("a".repeat(64)).first()).toBeVisible();
  await expect(page.getByText("9 个 SKU")).toBeVisible();
  await expect(page.getByText("已保留最近成功快照")).toBeVisible();
  await expect(page.getByText("同步失败，沿用旧快照")).toHaveCount(0);
  await page.getByRole("button", { name: "主动刷新当日价格" }).click();
  await expect(page.getByRole("dialog", { name: "确认刷新当日价格？" })).toBeVisible();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("当日价格同步任务已提交，可在此页持续追踪。")).toBeVisible();
  await expect(page.getByRole("button", { name: "同步任务执行中" })).toBeDisabled();
  expect(submitted).toBe(1); expect(idempotencyKey).toBeTruthy();
});

test("checksum 不匹配会提示管理员决定是否覆写，并仅投递带覆写标记的任务", async ({ page }) => {
  await loginAdmin(page);
  let submittedPayload: unknown = null;
  await page.route("**/v1/admin/prices/sync", async (route) => {
    if (route.request().method() === "POST") {
      submittedPayload = route.request().postDataJSON();
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ id: jobId, type: "prices.sync", status: "pending", attempt: 0, maxAttempts: 3, uniqueKey: "prices.sync:checksum-bypass", scheduledAt: now, lockedUntil: null, lastError: null, updatedAt: now })) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ latestSuccessful: null, current: { ...failedRun, failureReason: "MTGJSON 文件 checksum 不匹配", failureCode: "CHECKSUM_MISMATCH", checksumVerification: "not_verified" }, currentJob: { id: jobId, type: "prices.sync", status: "failed", attempt: 1, maxAttempts: 3, uniqueKey: "prices.sync:checksum-bypass", scheduledAt: now, lockedUntil: null, lastError: "MTGJSON 文件 checksum 不匹配", updatedAt: now }, checksumBypassAvailable: true })) });
  });
  await page.getByRole("link", { name: "价格同步" }).click();
  await expect(page.getByRole("dialog", { name: "检测到校验和不匹配" })).toBeVisible();
  await expect(page.getByText("继续将直接使用未验证的下载价格")).toBeVisible();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("已提交未校验价格覆写任务；完成后会明确标记为管理员绕过。")).toBeVisible();
  expect(submittedPayload).toEqual({ allowChecksumMismatch: true });
});

test("玩家只查看公开来源、更新时间、无价和过期状态，不读取管理快照详情", async ({ page }) => {
  const email = `price-status-player-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("价格状态玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill("playwright-password-123");
  await page.getByRole("button", { name: "创建账号" }).click();
  const calls: string[] = [];
  await page.route("**/v1/prices/status", async (route) => {
    calls.push(route.request().url());
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ source: "mtgjson-cardmarket", updatedAt: now, freshness: "stale" })) });
  });
  await page.route("**/v1/catalog/cards?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({
    items: [{ id: "40000000-0000-4000-8000-000000000001", printingId: "30000000-0000-4000-8000-000000000001", scryfallId: "20000000-0000-4000-8000-000000000001", name: "无价夹具卡", setCode: "TST", setName: "测试系列", collectorNumber: "1", finish: "nonfoil", rarity: "rare", legalities: {}, imagePath: null, tradable: false, source: "scryfall", sourceReference: "fixture", isManualException: false, image: { path: null, sourceUrl: null, status: "missing", cachedAt: null } }],
    page: { nextCursor: null, hasMore: false, total: 1 }
  })) }));
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({
    accessToken: "player-price-status-fixture-token",
    user: { id: "30000000-0000-4000-8000-000000000001", email, displayName: "价格状态玩家", role: "player", createdAt: now }
  })) }));
  await allowFixtureSessionRecovery(page);
  await page.goto("/catalog");
  await expect(page.getByText("MTGJSON / Cardmarket EUR 参考价")).toBeVisible();
  await expect(page.getByText("同步失败，沿用旧快照")).toBeVisible();
  await expect(page.getByText("无有效参考价，暂不可新增交易")).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls.every((url) => url.includes("/v1/prices/status") && !url.includes("/v1/admin/"))).toBe(true);
});

test("普通玩家没有价格同步入口，管理页面和 API 都被拒绝", async ({ page, request }) => {
  const email = `price-admin-player-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("价格权限玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill("playwright-password-123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("link", { name: "价格同步" })).toHaveCount(0);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({
    accessToken: "player-price-sync-fixture-token",
    user: { id: "20000000-0000-4000-8000-000000000001", email, displayName: "价格权限玩家", role: "player", createdAt: now }
  })) }));
  await allowFixtureSessionRecovery(page);
  await page.goto("/admin/price-sync");
  await expect(page.getByRole("heading", { name: "无权访问此页面" })).toBeVisible();
  const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";
  const session = await request.post(`${apiBaseUrl}/v1/auth/login`, { data: { email, password: "playwright-password-123" } });
  const token = (await session.json() as { data: { accessToken: string } }).data.accessToken;
  const denied = await request.get(`${apiBaseUrl}/v1/admin/prices/sync`, { headers: { Authorization: `Bearer ${token}` } });
  expect(denied.status()).toBe(403);
});
