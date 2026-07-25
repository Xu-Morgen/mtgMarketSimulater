import { expect, test, type Page } from "@playwright/test";

const password = "playwright-password-123";
const activePackId = "50000000-0000-4000-8000-000000000011";
const disabledPackId = "50000000-0000-4000-8000-000000000012";
const activePack = {
  id: activePackId,
  code: "PLAY-01",
  name: "测试补充包",
  description: "用于验证服务端概率公示。",
  price: { amount: 500, currency: "GAME_CREDIT" },
  enabled: true,
  disabledReason: null,
  ruleVersion: "pack/v1",
  updatedAt: "2026-07-26T08:00:00.000Z",
  slots: [
    {
      id: "regular",
      draws: 2,
      rarityProbabilities: [
        { rarity: "common", probabilityBasisPoints: 9000 },
        { rarity: "rare", probabilityBasisPoints: 1000 }
      ]
    }
  ]
};
const disabledPack = {
  ...activePack,
  id: disabledPackId,
  code: "PLAY-02",
  name: "已结束补充包",
  enabled: false,
  disabledReason: "活动已结束"
};

function envelope(data: unknown) {
  return { ok: true, data, meta: { requestId: "i11f-e2e" } };
}

async function registerPlayer(page: Page): Promise<void> {
  await page.goto("/register");
  await page.getByLabel("显示名称").fill("补充包测试玩家");
  await page
    .getByLabel("邮箱")
    .fill(`packs-${test.info().project.name}-${Date.now()}@example.test`);
  await page.getByRole("textbox", { name: "密码" }).fill(password);
  await page.getByRole("button", { name: "创建账号" }).click();
  await expect(page.getByRole("link", { name: "补充包商店" })).toBeVisible();
}

test("玩家可查看服务端补充包、禁用原因和版本化概率详情，页面不提供抽卡入口", async ({ page }) => {
  await registerPlayer(page);
  await page.route("**/v1/packs", async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items: [activePack, disabledPack] }))
    })
  );
  await page.route(`**/v1/packs/${activePackId}`, async (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ pack: activePack }))
    })
  );
  await page.getByRole("link", { name: "补充包商店" }).click();
  await expect(page.getByRole("heading", { name: "补充包商店" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("当前不可购买：")).toBeVisible();
  await expect(page.getByText("活动已结束")).toBeVisible();
  await page.getByRole("link", { name: "查看概率详情" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/packs/${activePackId}$`));
  await expect(page.getByRole("heading", { name: "测试补充包" })).toBeVisible();
  await expect(page.getByText("pack/v1")).toBeVisible();
  await expect(page.getByText("90.00%（9,000 bp）")).toBeVisible();
  await expect(page.getByText("MVP 未启用保底机制")).toBeVisible();
  await expect(page.getByRole("button", { name: /购买|开包/ })).toHaveCount(0);
});

test("补充包页覆盖概率加载、空列表、失败重试和规则版本刷新", async ({ page }) => {
  await registerPlayer(page);
  let state: "loading" | "empty" | "failed" | "v1" | "v2" = "loading";
  await page.route("**/v1/packs", async (route) => {
    if (state === "loading") {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify(envelope({ items: [activePack] }))
      });
    }
    if (state === "failed")
      return route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: { code: "INTERNAL_ERROR", message: "补充包暂不可用" },
          meta: { requestId: "i11f-failure" }
        })
      });
    const items =
      state === "empty"
        ? []
        : [{ ...activePack, ruleVersion: state === "v2" ? "pack/v2" : "pack/v1" }];
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(envelope({ items }))
    });
  });
  await page.goto("/packs");
  await expect(page.locator('[aria-busy="true"]')).toBeVisible();
  await expect(page.getByText("测试补充包")).toBeVisible();
  state = "empty";
  await page.reload();
  await expect(page.getByRole("heading", { name: "暂无可公示的补充包" })).toBeVisible();
  state = "failed";
  await page.reload();
  await expect(page.getByRole("heading", { name: "补充包加载失败" })).toBeVisible();
  state = "v2";
  await page.getByRole("button", { name: "重试" }).click();
  await expect(page.getByText("pack/v2")).toBeVisible();
});
