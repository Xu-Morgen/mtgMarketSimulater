import { expect, test, type Page } from "@playwright/test";

const jobId = "70000000-0000-4000-8000-000000000001";
const now = "2026-07-24T08:00:00.000Z";
const successRun = { id: "60000000-0000-4000-8000-000000000001", sourceVersion: "2026-07-24T00:00:00.000Z", checksumSha256: "a".repeat(64), enabledSetCodes: ["ONE"], status: "succeeded", importedPrintings: 12, importedSkus: 20, cachedImages: 0, diff: { added: 2, removed: 1 }, failureReason: null, startedAt: now, completedAt: now };
const failedRun = { ...successRun, id: "60000000-0000-4000-8000-000000000002", status: "failed", sourceVersion: "unavailable", importedPrintings: 0, importedSkus: 0, failureReason: "Scryfall Bulk 文件下载失败：HTTP 503", completedAt: now };

async function loginAdmin(page: Page): Promise<void> {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(process.env.E2E_ADMIN_EMAIL!);
  await page.getByRole("textbox", { name: "密码" }).fill(process.env.E2E_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/admin$/);
}

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i09f-e2e" } }; }

test("管理员可确认触发同步；等待任务时禁止重复提交且不会请求外部 Provider", async ({ page }) => {
  await loginAdmin(page);
  let submitted = 0; let statusCalls = 0; const urls: string[] = [];
  await page.route("**/v1/admin/catalog/sync", async (route) => {
    urls.push(route.request().url());
    if (route.request().method() === "POST") { submitted += 1; return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ id: jobId, type: "catalog.sync", status: "pending", attempt: 0, maxAttempts: 3, uniqueKey: "catalog.sync:fixture", scheduledAt: now, lockedUntil: null, lastError: null, updatedAt: now })) }); }
    statusCalls += 1;
    const currentJob = statusCalls > 1 ? { id: jobId, type: "catalog.sync", status: "pending", attempt: 0, maxAttempts: 3, uniqueKey: "catalog.sync:fixture", scheduledAt: now, lockedUntil: null, lastError: null, updatedAt: now } : null;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ latestSuccessful: successRun, current: successRun, currentJob, currentImageCacheJob: null })) });
  });
  await page.getByRole("link", { name: "目录同步" }).click();
  await expect(page.getByRole("heading", { name: "目录同步" })).toBeVisible();
  await expect(page.getByText("2026-07-24T00:00:00.000Z").first()).toBeVisible();
  await page.getByRole("button", { name: "触发目录同步" }).click();
  await expect(page.getByRole("dialog", { name: "确认触发目录同步？" })).toBeVisible();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("目录同步任务已提交，可在此页持续追踪。")).toBeVisible();
  await expect(page.getByRole("button", { name: "触发目录同步" })).toBeDisabled();
  expect(submitted).toBe(1);
  expect(urls.every((url) => url.startsWith("http://localhost:3001/v1/admin/catalog/sync"))).toBe(true);
});

test("管理员可查看失败摘要和旧目录，并二次确认重试失败任务", async ({ page }) => {
  await loginAdmin(page);
  let retryCalls = 0;
  await page.route("**/v1/admin/catalog/sync", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ latestSuccessful: successRun, current: failedRun, currentJob: { id: jobId, type: "catalog.sync", status: "failed", attempt: 1, maxAttempts: 3, uniqueKey: "catalog.sync:fixture", scheduledAt: now, lockedUntil: null, lastError: "Scryfall Bulk 文件下载失败：HTTP 503", updatedAt: now }, currentImageCacheJob: null })) }));
  await page.route(`**/v1/admin/jobs/${jobId}/retry`, async (route) => { retryCalls += 1; return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ id: jobId, type: "catalog.sync", status: "pending", attempt: 0, maxAttempts: 3, uniqueKey: "catalog.sync:fixture", scheduledAt: now, lockedUntil: null, lastError: null, updatedAt: now })) }); });
  await page.goto("/admin/catalog-sync");
  await expect(page.getByText("最近成功版本")).toBeVisible();
  await expect(page.getByText("Scryfall Bulk 文件下载失败：HTTP 503").first()).toBeVisible();
  await page.getByRole("button", { name: "重试失败任务" }).click();
  await expect(page.getByRole("dialog", { name: "确认重试目录同步？" })).toBeVisible();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("失败任务已重新排队。")).toBeVisible();
  expect(retryCalls).toBe(1);
});

test("管理员可按单张 SKU 或系列投递本地卡图缓存任务", async ({ page }) => {
  await loginAdmin(page);
  const imageJob = { id: "70000000-0000-4000-8000-000000000002", type: "catalog.image-cache", status: "pending", attempt: 0, maxAttempts: 3, uniqueKey: "catalog.image-cache:fixture", scheduledAt: now, lockedUntil: null, lastError: null, updatedAt: now };
  const payloads: unknown[] = [];
  await page.route("**/v1/admin/catalog/sync", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ latestSuccessful: successRun, current: successRun, currentJob: null, currentImageCacheJob: null })) }));
  await page.route("**/v1/admin/catalog/image-cache", async (route) => { payloads.push(route.request().postDataJSON()); return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope(imageJob)) }); });
  await page.goto("/admin/catalog-sync");
  await page.getByLabel("单张图片 SKU ID").fill("30000000-0000-4000-8000-000000000001");
  await page.getByRole("button", { name: "缓存单张图片" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("单张卡图缓存任务已提交。")).toBeVisible();
  await page.getByLabel("批量图片系列代码").fill("one");
  await page.getByRole("button", { name: "缓存系列图片" }).click();
  await page.getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("系列卡图缓存任务已提交。")).toBeVisible();
  expect(payloads).toEqual([{ scope: "single", skuId: "30000000-0000-4000-8000-000000000001" }, { scope: "set", setCode: "ONE" }]);
});

test("普通玩家没有目录同步入口，管理同步 API 仍返回 403", async ({ page, request }) => {
  const email = `catalog-sync-player-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("同步权限玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill("playwright-password-123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("link", { name: "目录同步" })).toHaveCount(0);
  await page.goto("/admin/catalog-sync");
  await expect(page.getByRole("heading", { name: "无权访问此页面" })).toBeVisible();
  const session = await request.post("http://localhost:3001/v1/auth/login", { data: { email, password: "playwright-password-123" } });
  const token = (await session.json() as { data: { accessToken: string } }).data.accessToken;
  const denied = await request.get("http://localhost:3001/v1/admin/catalog/sync", { headers: { Authorization: `Bearer ${token}` } });
  expect(denied.status()).toBe(403);
});
