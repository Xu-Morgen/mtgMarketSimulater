import { expect, test, type Page } from "@playwright/test";

const password = "playwright-password-123";
const now = "2026-07-24T08:00:00.000Z";
const holding = {
  skuId: "30000000-0000-4000-8000-000000000081", quantity: 4, availableQuantity: 1, orderLockedQuantity: 2, tournamentLockedQuantity: 1,
  averageCost: { amount: 120 }, marketValue: null, updatedAt: now, marketValueUnavailableReason: "no_snapshot",
  sku: { id: "30000000-0000-4000-8000-000000000081", name: "库存测试卡", setCode: "ONE", setName: "Phyrexia: All Will Be One", collectorNumber: "10", finish: "foil", imagePath: null, tradable: true }
};

function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i10f-e2e" } }; }

async function registerPlayer(page: Page): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("库存测试玩家");
  await page.getByLabel("邮箱").fill(`inventory-${test.info().project.name}-${Date.now()}@example.test`);
  await page.getByRole("textbox", { name: "密码" }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("link", { name: "我的库存" })).toBeVisible();
}

test("库存页显示服务端锁定量和无价原因，筛选排序分页均写入 URL", async ({ page }) => {
  await registerPlayer(page);
  const urls: string[] = [];
  await page.route("**/v1/inventory?*", async (route) => {
    urls.push(route.request().url());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [holding], page: { total: 42, hasMore: true, nextCursor: "20" } })) });
  });
  await page.getByRole("link", { name: "我的库存" }).click();
  await expect(page.getByRole("heading", { name: "我的库存" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("cell", { name: "2" }).first()).toBeVisible();
  await expect(page.getByText("尚无有效价格快照，暂不显示市值。")).toBeVisible();
  await expect(page.getByText("已锁定")).toBeVisible();
  await page.getByLabel("库存工艺筛选").selectOption("foil");
  await page.getByLabel("库存锁定筛选").selectOption("locked");
  await page.getByRole("button", { name: "应用筛选" }).click();
  await expect(page).toHaveURL(/finish=foil/);
  await expect(page).toHaveURL(/locked=locked/);
  await page.getByLabel("库存排序").selectOption("quantity:desc");
  await expect(page).toHaveURL(/sort=quantity/);
  await page.locator(".ant-pagination-item").filter({ hasText: "2" }).click();
  await expect(page).toHaveURL(/cursor=20/);
  expect(urls.every((url) => url.startsWith("http://localhost:3001/v1/inventory?"))).toBe(true);
});

test("库存空态、查询失败与刷新恢复均有明确反馈", async ({ page }) => {
  await registerPlayer(page);
  let response: "empty" | "failed" | "holding" = "empty";
  await page.route("**/v1/inventory?*", async (route) => {
    if (response === "failed") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code: "INTERNAL_ERROR", message: "库存暂不可用" }, meta: { requestId: "i10f-failure" } }) });
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: response === "empty" ? [] : [holding], page: { total: response === "empty" ? 0 : 1, hasMore: false, nextCursor: null } })) });
  });
  await page.goto("/inventory");
  await expect(page.getByRole("heading", { name: "库存为空" })).toBeVisible({ timeout: 15_000 });
  response = "failed";
  await page.getByRole("button", { name: "刷新" }).click();
  await expect(page.getByRole("heading", { name: "库存加载失败" })).toBeVisible();
  response = "holding";
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("库存测试卡")).toBeVisible();
});
