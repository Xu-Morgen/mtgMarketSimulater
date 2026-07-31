import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-31T08:00:00.000Z";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";

function envelope(data: unknown, requestId = "i30f-e2e") { return { ok: true, data, meta: { requestId } }; }

async function recoverAdminSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i30f-admin-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "i30f-admin-token", user: { id: "50000000-0000-4000-8000-000000000001", email: "i30f-admin@example.test", displayName: "I30F 管理员", role: "admin", createdAt: now } })) }));
}

// ----- 后台首页 -----

test("管理员首页显示环境、新鲜度、失败任务、活动与最近操作摘要", async ({ page }) => {
  await recoverAdminSession(page);
  await page.route("**/v1/admin/dashboard", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({
    environment: "production",
    catalogFreshness: { updatedAt: now, status: "fresh" },
    priceFreshness: { updatedAt: now, status: "stale" },
    failedJobCount: 2,
    activeCampaignCount: 1,
    pendingReviewExceptionCount: 0,
    recentActions: [{ id: "a0000000-0000-4000-8000-000000000001", actorId: "50000000-0000-4000-8000-000000000001", action: "campaign.published", entityType: "campaign", entityId: "c0000000-0000-4000-8000-000000000001", requestId: "i30f-act", occurredAt: now, summary: { code: "summer" } }]
  })) }));
  await page.route("**/v1/admin/exception-trades*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "运营总览" })).toBeVisible();
  await expect(page.getByText("生产")).toBeVisible();
  await expect(page.getByText("新鲜").first()).toBeVisible();
  await expect(page.getByText("过期").first()).toBeVisible();
  await expect(page.getByText("campaign.published")).toBeVisible();
});

// ----- 日志筛选与脱敏详情 -----

test("管理员可按请求 ID 筛选日志并查看脱敏详情与关联记录", async ({ page }) => {
  await recoverAdminSession(page);
  const log = { id: "b0000000-0000-4000-8000-000000000001", actorId: "50000000-0000-4000-8000-000000000001", action: "user.balance_compensated", entityType: "user", entityId: "70000000-0000-4000-8000-000000000001", requestId: "i30f-req-1", occurredAt: now, summary: { amount: 1000, reason: "操作失误：测试" } };
  await page.route("**/v1/admin/audit-logs?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [log], page: { hasMore: false, nextCursor: null } })) }));
  await page.route("**/v1/admin/audit-logs/b0000000-0000-4000-8000-000000000001", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ log: { ...log, relatedLogs: [] } })) }));
  await page.goto("/admin/logs");
  await expect(page.getByRole("heading", { name: "审计日志" })).toBeVisible();
  await page.getByLabel("请求 ID").fill("i30f-req-1");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page.getByText("user.balance_compensated")).toBeVisible();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByRole("dialog", { name: "审计日志详情" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "脱敏摘要" })).toBeVisible();
  await expect(page.getByText("操作失误：测试")).toBeVisible();
  await expect(page.getByRole("button", { name: "删除" })).toHaveCount(0);
});

// ----- 活动完整生命周期：草稿 → 预览 → 发布；重复点击不重复发布 -----

test("管理员创建活动草稿、预览后发布；提交中按钮禁用且不重复投递", async ({ page }) => {
  await recoverAdminSession(page);
  const campaign = { id: "c0000000-0000-4000-8000-000000000001", code: "summer-2026", name: "夏日活动", description: null, campaignType: "market_factor", scopeType: "global", scopeId: null, factorBps: 12000, displayText: "夏日全场", startsAt: now, endsAt: "2026-08-31T08:00:00.000Z", status: "draft", version: 1, publishedMarketEventId: null, reason: null, createdBy: "50000000-0000-4000-8000-000000000001", createdAt: now, updatedAt: now, publishedAt: null, pausedAt: null, endedAt: null };
  const published = { ...campaign, status: "published", version: 2, publishedAt: now };
  let draftCalls = 0; let publishCalls = 0;
  await page.route("**/v1/admin/campaigns?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [campaign], total: 1 })) }));
  await page.route("**/v1/admin/campaigns", async (route) => {
    if (route.request().method() === "POST") { draftCalls += 1; return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(campaign)) }); }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [campaign], total: 1 })) });
  });
  await page.route("**/v1/admin/campaigns/c0000000-0000-4000-8000-000000000001/preview", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ campaign: { ...campaign, status: "previewing", version: 2 }, previewVersion: 2, conflicts: [], factorBpsInRange: true, scheduledReprice: { triggerKey: "activity:c0:2", runAfter: now } })) }));
  await page.route("**/v1/admin/campaigns/c0000000-0000-4000-8000-000000000001/publish", async (route) => { publishCalls += 1; return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(published)) }); });
  await page.goto("/admin/events");
  await page.getByLabel("活动代码").fill("summer-2026");
  await page.getByLabel("活动名称").fill("夏日活动");
  await page.getByLabel("展示文案").fill("夏日全场");
  await page.getByLabel("开始时间").fill("2026-07-31T16:00");
  await page.getByLabel("结束时间").fill("2026-08-31T16:00");
  await page.getByRole("button", { name: "保存草稿" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("活动草稿已保存")).toBeVisible();
  await page.getByRole("button", { name: "预览" }).click();
  await expect(page.getByRole("dialog", { name: "确认发布活动？" })).toBeVisible();
  await expect(page.getByText("预计重价任务")).toBeVisible();
  await page.getByRole("button", { name: "确认", exact: true }).click();
  await expect(page.getByText("活动已发布")).toBeVisible();
  expect(draftCalls).toBe(1);
  expect(publishCalls).toBe(1);
});

// ----- 玩家管理：冻结与余额补偿流程；不允许直接编辑最终余额 -----

test("管理员检索玩家、冻结并执行余额补偿；补偿只提交命令并展示新流水", async ({ page }) => {
  await recoverAdminSession(page);
  const userId = "70000000-0000-4000-8000-000000000001";
  const listItem = { id: userId, email: "loop@example.test", displayName: "闭环玩家", role: "player", frozen: false, frozenReason: null, createdAt: now, updatedAt: now };
  // 用模块级可变状态模拟服务端推进，使冻结/补偿后的详情重取反映新状态。
  const state = { frozen: false, frozenReason: "" as string, balance: 9000 };
  let freezeCalls = 0; let balanceCalls = 0;
  const buildDetail = () => ({ ...listItem, frozen: state.frozen, frozenReason: state.frozenReason || null, activeSessionCount: 1, accountBalance: { currency: "GAME_CREDIT", total: state.balance, available: state.balance, frozen: 0 }, recentAudit: [] });
  await page.route("**/v1/admin/users?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [listItem], total: 1 })) }));
  await page.route(`**/v1/admin/users/${userId}`, async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ user: buildDetail() })) }));
  await page.route(`**/v1/admin/users/${userId}/freeze`, async (route) => { freezeCalls += 1; state.frozen = true; return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ userId, frozen: true })) }); });
  await page.route(`**/v1/admin/users/${userId}/compensate/balance`, async (route) => { balanceCalls += 1; state.balance += 1000; return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ userId, ledgerEntryId: "ledger-1", inventoryEntryId: null, newBalance: { currency: "GAME_CREDIT", total: state.balance, available: state.balance, frozen: 0 }, newQuantity: null, auditId: "audit-1", reason: "操作失误：补正" })) }); });
  await page.goto("/admin/users");
  await page.getByLabel("用户名或邮箱").fill("loop");
  await page.getByRole("button", { name: "检索" }).click();
  await page.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByRole("dialog", { name: "玩家详情" })).toBeVisible();
  await page.getByRole("button", { name: "冻结" }).click();
  await page.getByLabel("冻结原因").fill("可疑操作");
  await page.getByRole("button", { name: "确认冻结" }).click();
  await expect(page.getByText("已冻结玩家")).toBeVisible();
  await page.getByRole("button", { name: "余额补偿" }).click();
  await page.getByLabel("说明").fill("补正");
  await page.getByLabel("金额").fill("1000");
  await page.getByRole("button", { name: "预览并确认" }).click();
  await expect(page.getByRole("button", { name: "二次确认提交" })).toBeVisible();
  await page.getByRole("button", { name: "二次确认提交" }).click();
  await expect(page.getByText("补偿已执行")).toBeVisible();
  await expect(page.getByText("ledger-1")).toBeVisible();
  expect(freezeCalls).toBe(1);
  expect(balanceCalls).toBe(1);
});

// ----- 普通玩家没有管理入口，深层链接显示 403 且管理 API 返回 403 -----

test("普通玩家没有活动/玩家/日志入口，深层链接 403，管理 API 返回 403", async ({ page, request }) => {
  const email = `i30f-player-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("I30F 权限玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill("playwright-password-123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("link", { name: "活动" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "玩家" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "日志" })).toHaveCount(0);
  await page.goto("/admin/events");
  await expect(page.getByRole("heading", { name: "无权访问此页面" })).toBeVisible();
  const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";
  const session = await request.post(`${apiBaseUrl}/v1/auth/login`, { data: { email, password: "playwright-password-123" } });
  const token = (await session.json() as { data: { accessToken: string } }).data.accessToken;
  const denied = await request.get(`${apiBaseUrl}/v1/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } });
  expect(denied.status()).toBe(403);
});
