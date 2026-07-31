import { expect, test, type Page } from "@playwright/test";

const now = "2026-07-31T08:00:00.000Z";
const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const apiBaseUrl = process.env.PLAYWRIGHT_API_BASE_URL ?? "http://localhost:3001";

function envelope(data: unknown, requestId = "i31f-e2e") { return { ok: true, data, meta: { requestId } }; }

const playerId = "30000000-0000-4000-8000-000000000040";
const adminId = "50000000-0000-4000-8000-000000000002";

async function recoverPlayerSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i31f-player-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "i31f-player-token", user: { id: playerId, email: "i31f-player@example.test", displayName: "I31F 导出玩家", role: "player", createdAt: now } })) }));
}

async function recoverAdminSession(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "mtg_csrf", value: "i31f-admin-csrf", url: webBaseUrl }]);
  await page.route("**/v1/auth/refresh", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "i31f-admin-token", user: { id: adminId, email: "i31f-admin@example.test", displayName: "I31F 备份管理员", role: "admin", createdAt: now } })) }));
}

const succeededExport = {
  id: "e0000000-0000-4000-8000-000000000001", kind: "all", format: "csv", fileName: "export-i31f-1.csv",
  sizeBytes: 256, status: "succeeded", failureReason: null, expiresAt: "2099-12-31T23:59:59.000Z", createdAt: now
};
const expiredExport = {
  id: "e0000000-0000-4000-8000-000000000002", kind: "all", format: "json", fileName: "export-i31f-2.json",
  sizeBytes: 128, status: "expired", failureReason: null, expiresAt: "2020-01-01T00:00:00.000Z", createdAt: "2020-01-01T00:00:00.000Z"
};
const failedExport = {
  id: "e0000000-0000-4000-8000-000000000003", kind: "all", format: "csv", fileName: "export-i31f-3.csv",
  sizeBytes: null, status: "failed", failureReason: "磁盘写入失败", expiresAt: "2099-12-31T23:59:59.000Z", createdAt: now
};

const backup = {
  id: "b0000000-0000-4000-8000-000000000010", kind: "scheduled", status: "succeeded",
  backupFileName: "backup-i31f.db", sizeBytes: 2048, sqliteIntegrityOk: true,
  sha256: "abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890", failureReason: null,
  createdBy: adminId, createdAt: now, completedAt: now, requestId: "i31f-backup-req"
};

// ----- 玩家生成导出并下载；重复点击只投递一次；CSV 安全样例不在浏览器拼装 -----

test("玩家生成导出并下载；提交期间禁用且只投递一次；下载内容保留服务端公式注入转义", async ({ page }) => {
  await recoverPlayerSession(page);
  let generateCalls = 0;
  await page.route("**/v1/exports", async (route) => {
    if (route.request().method() === "POST") { generateCalls += 1; return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ export: succeededExport, skipped: false })) }); }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [succeededExport] })) });
  });
  // 下载接口返回服务端已转义的 CSV 样例（'=evil 前缀单引号），断言浏览器下载链路不破坏转义。
  await page.route("**/v1/exports/e0000000-0000-4000-8000-000000000001/download", async (route) => route.fulfill({ status: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="export-i31f-1.csv"' }, body: "# ledger\nreason,balance\n'=evil|cmd,100\n" }));

  const downloadPromise = page.waitForEvent("download");
  await page.goto("/exports");
  await expect(page.getByRole("heading", { name: "我的数据导出" })).toBeVisible();
  // 不勾选额外格式，默认 CSV；点击生成 → 二次确认。
  await page.getByRole("button", { name: "生成导出" }).click();
  await expect(page.getByRole("dialog", { name: "确认生成导出？" })).toBeVisible();
  const confirmButton = page.getByRole("dialog", { name: "确认生成导出？" }).getByRole("button", { name: "确认" });
  // 提交期间按钮存在；点击一次。
  await confirmButton.click();
  await expect(page.getByText("导出已生成")).toBeVisible();
  // 列表出现可下载记录。
  await expect(page.getByText("export-i31f-1.csv")).toBeVisible();
  await expect(page.getByText("可下载")).toBeVisible();
  // 下载：二次确认后触发受控流。
  await page.getByRole("button", { name: "下载" }).click();
  await page.getByRole("dialog", { name: "确认下载导出文件？" }).getByRole("button", { name: "确认" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("export-i31f-1.csv");
  // 下载文本保留服务端前置单引号，且不含裸 =evil 公式。
  const stream = await download.createReadStream();
  let body = "";
  for await (const chunk of stream) body += chunk.toString();
  expect(body).toContain("'=evil|cmd");
  expect(body).not.toMatch(/[^']=evil\|cmd/);
  // 页面不在浏览器拼装 CSV：无编辑器/文本域承载报表内容。
  await expect(page.getByRole("textbox")).toHaveCount(0);
  expect(generateCalls).toBe(1);
});

// ----- 过期/失败状态、失败原因展示与失败重试 -----

test("过期与失败记录不可下载并显示原因；失败后重新生成成功并刷新列表", async ({ page }) => {
  await recoverPlayerSession(page);
  const items = { current: [succeededExport, expiredExport, failedExport] };
  await page.route("**/v1/exports", async (route) => {
    if (route.request().method() === "POST") { items.current = [{ ...succeededExport, id: "e0000000-0000-4000-8000-000000000099", fileName: "export-i31f-retry.csv" }]; return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ export: items.current[0], skipped: false })) }); }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: items.current })) });
  });
  await page.goto("/exports");
  // 过期记录行：状态为「已过期」且操作列为禁用占位（无下载按钮）。
  const expiredRow = page.getByRole("row", { name: /export-i31f-2\.json/ });
  await expect(expiredRow).toBeVisible();
  await expect(expiredRow.getByLabel("不可下载")).toBeVisible();
  await expect(expiredRow.getByRole("button", { name: "下载" })).toHaveCount(0);
  // 失败记录行：显示失败原因且无下载按钮。
  const failedRow = page.getByRole("row", { name: /export-i31f-3\.csv/ });
  await expect(failedRow.getByText("磁盘写入失败")).toBeVisible();
  await expect(failedRow.getByLabel("不可下载")).toBeVisible();
  await expect(failedRow.getByRole("button", { name: "下载" })).toHaveCount(0);
  // 重新生成成功后列表刷新为新的可下载记录。
  await page.getByRole("button", { name: "生成导出" }).click();
  await page.getByRole("dialog", { name: "确认生成导出？" }).getByRole("button", { name: "确认" }).click();
  await expect(page.getByText("导出已生成")).toBeVisible();
  await expect(page.getByText("export-i31f-retry.csv")).toBeVisible();
});

// ----- 管理员备份状态、受控下载与只读恢复演练 -----

test("管理员查看备份状态摘要、受控下载并在只读副本上演练恢复", async ({ page }) => {
  await recoverAdminSession(page);
  await page.route("**/v1/admin/backups?*", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [backup] })) }));
  await page.route("**/v1/admin/backups/b0000000-0000-4000-8000-000000000010/download", async (route) => route.fulfill({ status: 200, headers: { "Content-Type": "application/octet-stream", "Content-Disposition": 'attachment; filename="backup-i31f.db"' }, body: "fake-sqlite-bytes" }));
  await page.route("**/v1/admin/backups/b0000000-0000-4000-8000-000000000010/restore-rehearsal", async (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ rehearsal: { backupId: backup.id, backupFileName: backup.backupFileName, sqliteIntegrityOk: true, coreTablesPresent: true, sampleCounts: { users: 5, accounts: 5, inventoryHoldings: 12, jobs: 3 } } })) }));

  const downloadPromise = page.waitForEvent("download");
  await page.goto("/admin/backups");
  await expect(page.getByRole("heading", { name: "备份与恢复演练" })).toBeVisible();
  // 摘要统计定位到摘要区，避免与表格行同名值冲突；SHA-256 前 12 位（不暴露完整哈希或路径）。
  const statGrid = page.getByLabel("备份摘要");
  await expect(statGrid.getByText("成功备份", { exact: true })).toBeVisible();
  await expect(statGrid.getByText("abcdef123456")).toBeVisible();
  await expect(page.getByText("/home/")).toHaveCount(0);
  // 受控下载：二次确认后触发流。
  await page.getByRole("button", { name: "下载" }).click();
  await page.getByRole("dialog", { name: "确认下载备份文件？" }).getByRole("button", { name: "确认" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("backup-i31f.db");
  // 恢复演练：二次确认后展示只读校验结果，明确不覆盖运行库。
  await page.getByRole("button", { name: "恢复演练" }).click();
  await page.getByRole("dialog", { name: "确认执行恢复演练？" }).getByRole("button", { name: "确认" }).click();
  await expect(page.getByRole("dialog", { name: "恢复演练结果（只读校验）" })).toBeVisible();
  await expect(page.getByText("未覆盖运行库")).toBeVisible();
  await expect(page.getByText("用户 5")).toBeVisible();
});

// ----- 普通玩家没有备份入口，深层链接 403 且管理 API 返回 403 -----

test("普通玩家没有备份入口，深层链接 403，备份管理 API 返回 403", async ({ page, request }) => {
  const email = `i31f-player-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("I31F 权限玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill("playwright-password-123");
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("link", { name: "备份" })).toHaveCount(0);
  // 玩家侧栏有导出入口，管理侧栏的备份入口不存在。
  await expect(page.getByRole("link", { name: "我的数据导出" })).toBeVisible();
  await page.goto("/admin/backups");
  await expect(page.getByRole("heading", { name: "无权访问此页面" })).toBeVisible();
  const session = await request.post(`${apiBaseUrl}/v1/auth/login`, { data: { email, password: "playwright-password-123" } });
  const token = (await session.json() as { data: { accessToken: string } }).data.accessToken;
  const denied = await request.get(`${apiBaseUrl}/v1/admin/backups`, { headers: { Authorization: `Bearer ${token}` } });
  expect(denied.status()).toBe(403);
});
