import { expect, test, type Page } from "@playwright/test";

const password = "playwright-password-123";

async function registerPlayer(page: Page): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("目录测试玩家");
  await page.getByLabel("邮箱").fill(`catalog-${test.info().project.name}-${Date.now()}@example.test`);
  await page.getByRole("textbox", { name: "密码" }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
}

test("玩家可分页浏览独立 SKU，并在详情中看到无图片降级", async ({ page }) => {
  await registerPlayer(page);
  await page.getByRole("link", { name: "卡牌目录" }).click();
  await expect(page.getByRole("heading", { name: "浏览印刷版本" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Elesh Norn, Mother of Machines" })).toHaveCount(2);
  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page).toHaveURL(/cursor=2/);
  await expect(page.getByRole("link", { name: "Elesh Norn, Mother of Machines" })).toHaveCount(1);
  await page.getByRole("link", { name: "Elesh Norn, Mother of Machines" }).click();
  await expect(page.getByText("暂无本地图片，已使用文字降级展示")).toBeVisible();
});

test("筛选会写入 URL，刷新后恢复；无结果和接口失败均可恢复", async ({ page }) => {
  await registerPlayer(page);
  await page.goto("/catalog");
  await page.getByLabel("工艺筛选").selectOption("foil");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page).toHaveURL(/finish=foil/);
  await expect(page.getByText("ONE · #10 · 闪")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("工艺筛选")).toHaveValue("foil");
  await page.getByLabel("名称筛选").fill("no-such-card");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page.getByRole("heading", { name: "没有符合条件的卡牌 SKU" })).toBeVisible();
  await page.route("**/v1/catalog/cards?*", async (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "目录暂不可用" }, meta: { requestId: "e2e" } }) }));
  await page.goto("/catalog");
  await expect(page.getByRole("heading", { name: "卡牌目录加载失败" })).toBeVisible();
  await page.unrouteAll({ behavior: "wait" });
});
