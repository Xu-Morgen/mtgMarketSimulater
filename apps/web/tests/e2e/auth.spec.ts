import { expect, test } from "@playwright/test";

const password = "playwright-password-123";
test("玩家可注册、刷新恢复、退出，错误密码会显示服务端错误", async ({ page, request }) => {
  const email = `player-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("测试玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "开始你的市场之旅" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill("definitely-wrong-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("认证凭据无效或已过期", { exact: true })).toBeVisible();
  const denied = await request.get("http://localhost:3001/v1/admin/jobs", { headers: { Authorization: "Bearer malformed" } });
  expect(denied.status()).toBe(401);
});

test("玩家创建存档后可刷新查看账本；同一幂等键重放不会产生第二份初始资金", async ({ page, request }) => {
  const email = `archive-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("存档测试玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.getByRole("button", { name: "创建游戏存档" }).click();
  await expect(page.getByRole("heading", { name: "账户概览" })).toBeVisible();
  await expect(page.getByText("初始资金", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "账户概览" })).toBeVisible();

  const session = await request.post("http://localhost:3001/v1/auth/login", { data: { email, password } });
  const accessToken = (await session.json() as { data: { accessToken: string } }).data.accessToken;
  const headers = { Authorization: `Bearer ${accessToken}`, "Idempotency-Key": "i07f-playwright-replay-0001" };
  const first = await request.post("http://localhost:3001/v1/archive", { headers, data: {} });
  const replay = await request.post("http://localhost:3001/v1/archive", { headers, data: {} });
  expect(first.status()).toBe(201);
  expect(replay.status()).toBe(200);
  expect((await replay.json() as { data: { archive: { id: string } } }).data.archive.id).toBe((await first.json() as { data: { archive: { id: string } } }).data.archive.id);
});

test("切换到新账户不会复用旧账户的存档缓存", async ({ page }) => {
  const suffix = `${test.info().project.name}-${Date.now()}`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("账户 A");
  await page.getByLabel("邮箱").fill(`account-a-${suffix}@example.test`);
  await page.getByRole("textbox", { name: "密码" }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.getByRole("button", { name: "创建游戏存档" }).click();
  await expect(page.getByRole("heading", { name: "账户概览" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();

  await page.goto("/register");
  await page.getByLabel("显示名称").fill("账户 B");
  await page.getByLabel("邮箱").fill(`account-b-${suffix}@example.test`);
  await page.getByRole("textbox", { name: "密码" }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("heading", { name: "开始你的市场之旅" })).toBeVisible();
  await expect(page.getByRole("button", { name: "创建游戏存档" })).toBeVisible();
});

test("普通玩家直接访问管理路由时显示 403，管理 API 同样拒绝", async ({ page, request }) => {
  const email = `forbidden-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("权限测试玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByRole("textbox", { name: "密码" }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "无权访问此页面" })).toBeVisible();
  const session = await request.post("http://localhost:3001/v1/auth/login", { data: { email, password } });
  const accessToken = (await session.json() as { data: { accessToken: string } }).data.accessToken;
  const response = await request.get("http://localhost:3001/v1/admin/jobs", { headers: { Authorization: `Bearer ${accessToken}` } });
  expect(response.status()).toBe(403);
});

test.describe("管理员登录", () => {
  test("管理员登录后进入独立后台", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("邮箱").fill(process.env.E2E_ADMIN_EMAIL!);
    await page.getByRole("textbox", { name: "密码" }).fill(process.env.E2E_ADMIN_PASSWORD!);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("navigation", { name: "管理导航" })).toBeVisible();
  });
});
