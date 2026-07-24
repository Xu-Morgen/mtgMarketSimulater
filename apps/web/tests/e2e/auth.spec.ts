import { expect, test } from "@playwright/test";

const password = "playwright-password-123";
test("玩家可注册、刷新恢复、退出，错误密码会显示服务端错误", async ({ page, request }) => {
  const email = `player-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("测试玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  await page.reload();
  await expect(page.getByRole("heading", { name: "欢迎回来" })).toBeVisible();
  await page.getByRole("button", { name: "退出登录" }).click();
  await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill("definitely-wrong-password");
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page.getByText("认证凭据无效或已过期", { exact: true })).toBeVisible();
  const denied = await request.get("http://localhost:3001/v1/admin/jobs", { headers: { Authorization: "Bearer malformed" } });
  expect(denied.status()).toBe(401);
});

test("普通玩家直接访问管理路由时显示 403，管理 API 同样拒绝", async ({ page, request }) => {
  const email = `forbidden-${test.info().project.name}-${Date.now()}@example.test`;
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("权限测试玩家");
  await page.getByLabel("邮箱").fill(email);
  await page.getByLabel("密码").fill(password);
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
    await page.getByLabel("密码").fill(process.env.E2E_ADMIN_PASSWORD!);
    await page.getByRole("button", { name: "登录" }).click();
    await expect(page).toHaveURL(/\/admin$/);
    await expect(page.getByRole("navigation", { name: "管理导航" })).toBeVisible();
  });
});
