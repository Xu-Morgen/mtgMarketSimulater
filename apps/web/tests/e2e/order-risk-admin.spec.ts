import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-29T08:00:00.000Z";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const riskDecision = {
  id: "90000000-0000-4000-8000-000000000001", orderId: null, skuId: "30000000-0000-4000-8000-000000000161",
  action: "create", outcome: "blocked", score: 90, reasons: ["cooldown", "self_trade"], ruleVersion: "order-risk/v1", createdAt: now
};
function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i21f-e2e" } }; }

async function recoverAdminSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "order-risk-admin-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "order-risk-admin-token", user: { id: "10000000-0000-4000-8000-000000000001", email: "risk-admin@example.test", displayName: "风控管理员", role: "admin", createdAt: now } })) }));
}

test("管理员只读查看异常订单、脱敏详情及关联日志入口", async ({ page }) => {
  await page.route("**/v1/admin/orders/risk-decisions?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [riskDecision], page: { total: 1, hasMore: false, nextCursor: null } })) }));
  await recoverAdminSession(page);
  await page.goto("/admin/orders/risk");
  await expect(page.getByRole("heading", { name: "异常订单" })).toBeVisible();
  await expect(page.getByText("已拦截", { exact: true })).toBeVisible();
  await expect(page.getByText("下单冷却中、可能自买自卖")).toBeVisible();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByRole("dialog", { name: "异常订单复核详情" })).toBeVisible();
  await expect(page.getByText("关联日志入口")).toBeVisible();
  await expect(page.getByText("创建前拦截，未生成订单")).toBeVisible();
  await expect(page.getByText("不显示用户身份、账户余额、库存、资金/库存冻结、请求体或凭据")).toBeVisible();
  await expect(page.getByRole("button", { name: "放行" })).toHaveCount(0);
});

test("普通玩家没有异常订单入口且管理 API 被拒绝", async ({ page, request }) => {
  const email = `order-risk-player-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("风控权限玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill("playwright-password-123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await expect(page.getByRole("link", { name: "异常订单" })).toHaveCount(0);
  await page.goto("/admin/orders/risk");
  await expect(page.getByRole("heading", { name: "无权访问此页面" })).toBeVisible();
  const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";
  const session = await request.post(`${apiBaseUrl}/v1/auth/login`, { data: { email, password: "playwright-password-123" } });
  const token = (await session.json() as { data: { accessToken: string } }).data.accessToken;
  const denied = await request.get(`${apiBaseUrl}/v1/admin/orders/risk-decisions`, { headers: { Authorization: `Bearer ${token}` } });
  expect(denied.status()).toBe(403);
});
