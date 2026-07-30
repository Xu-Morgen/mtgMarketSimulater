import { expect, test, type Page } from "@playwright/test";

const webBaseUrl = process.env.PLAYWRIGHT_WEB_BASE_URL ?? "http://localhost:3000";
const now = "2026-07-30T08:00:00.000Z";
const tournamentId = "10000000-0000-4000-8000-000000000251";
const deckId = "10000000-0000-4000-8000-000000000252";
const playerTournamentId = "10000000-0000-4000-8000-000000000253";
const registrationId = "10000000-0000-4000-8000-000000000254";
const roundId = "10000000-0000-4000-8000-000000000255";
function envelope(data: unknown) { return { ok: true, data, meta: { requestId: "i25f-e2e" } }; }
function failure(code: string, message: string) { return { ok: false, error: { code, message }, meta: { requestId: "i25f-e2e" } }; }
const tournament = { id: tournamentId, templateId: "daily-swiss", naturalDate: "2026-07-30", kind: "swiss", totalSeats: 8, entryFee: { amount: 20, currency: "GAME_CREDIT" }, difficulty: 3, entryCondition: "valid_commander_deck", dailyRegistrationLimit: 1, startMode: "on_registration", opensAt: now, cutoffAt: null, status: "open", ruleVersion: "tournament/v1", registered: false, createdAt: now, settledAt: null } as const;
const deck = { id: deckId, name: "服务端合法卡组", format: "commander-100/v1", ruleVersion: "commander-100/v1", banlistVersion: "commander-banlist/2026-07-29", cards: [], legality: { valid: true, totalCards: 100, colorIdentity: ["R"], issues: [], ruleVersion: "commander-100/v1", banlistVersion: "commander-banlist/2026-07-29", checkedAt: now }, strengthSnapshot: null, createdAt: now, updatedAt: now };
const result = { tournamentId, registrationId, rank: 1, wins: 3, draws: 0, losses: 0, byes: 0, forfeits: 0, points: 12, reward: { amount: 80, currency: "GAME_CREDIT" }, rewardDetail: { kind: "pack", amount: 1, packId: "BRO-BASE", skuId: null }, ruleVersion: "tournament/v1", settledAt: now, replay: { seed: "public-npc-seed", playerScore: 72, npcScores: [{ id: "npc-1", score: 61 }], swissCut: 4, standings: [], rounds: [{ round: 1, opponentName: "NPC 一号", outcome: "win", stage: "swiss" }] } };

async function session(page: Page) { await page.context().addCookies([{ name: "mtg_csrf", value: "i25f-csrf", url: webBaseUrl }]); await page.route("**/v1/auth/refresh", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ accessToken: "i25f-token", user: { id: "10000000-0000-4000-8000-000000000250", email: "tournament@example.test", displayName: "赛事测试玩家", role: "player", createdAt: now } })) })); }
async function common(page: Page, items: unknown[] = [tournament]) {
  await page.route("**/v1/tournaments/history", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await page.route("**/v1/tournament-pack-grants", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await page.route("**/v1/player-tournament-pack-grants", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }));
  await page.route("**/v1/player-tournaments", (route) => route.request().method() === "GET" ? route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [] })) }) : route.fallback());
  await page.route("**/v1/tournaments", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items })) }));
}

test("今日无比赛、服务端历史空态与创建入口可读", async ({ page }) => {
  await common(page, []); await session(page); await page.goto("/tournaments");
  await expect(page.getByText("今日没有可用比赛")).toBeVisible();
  await expect(page.getByText("尚无已报名的历史赛事。")).toBeVisible();
  await page.getByRole("link", { name: "创建玩家赛事" }).click();
  await expect(page.getByRole("heading", { name: "创建比赛" })).toBeVisible();
  await expect(page.getByText("不读取、保存或锁定实体卡组")).toBeVisible();
});

test("报名确认只提交卡组 ID，重复点击不会额外提交，非法报名显示服务端错误", async ({ page }) => {
  await common(page); await page.route("**/v1/decks", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [deck] })) }));
  let calls = 0;
  await page.route(`**/v1/tournaments/${tournamentId}/register`, async (route) => { calls++; await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify(failure("RULE_VIOLATION", "服务端拒绝：卡组已被比赛锁定")) }); });
  await session(page); await page.goto("/tournaments"); await page.getByRole("button", { name: "报名预览与确认" }).click(); await page.getByLabel("报名卡组").selectOption(deckId); await page.getByRole("button", { name: "确认报名" }).dblclick();
  await expect(page.getByText("服务端拒绝：卡组已被比赛锁定")).toBeVisible(); expect(calls).toBe(1);
});

test("合法报名由服务器确认并关闭确认框，不在浏览器生成评分或奖励", async ({ page }) => {
  await common(page); await page.route("**/v1/decks", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [deck] })) }));
  let body: unknown = null;
  await page.route(`**/v1/tournaments/${tournamentId}/register`, async (route) => { body = route.request().postDataJSON(); await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify(envelope({ registration: { id: registrationId, tournamentId, deckId, powerSnapshot: { source: "leyline", sourceVersion: "adapter/v1", providerAlgorithmVersion: "undeclared", score: 72, inputSummarySha256: "a".repeat(64), computedAt: now, availability: "available", degradationReason: null, responseSha256: "b".repeat(64) }, status: "registered", registeredAt: now } })) }); });
  await session(page); await page.goto("/tournaments"); await page.getByRole("button", { name: "报名预览与确认" }).click(); await page.getByLabel("报名卡组").selectOption(deckId); await page.getByRole("button", { name: "确认报名" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0); expect(body).toEqual({ deckId });
});

test("立即/截止结算、随机奖励、NPC 重放与历史结果均只读服务端字段", async ({ page }) => {
  const registered = { ...tournament, registered: true, status: "settling" as const, startMode: "at_cutoff" as const, cutoffAt: "2026-07-30T09:00:00.000Z" };
  await common(page, [registered]);
  await page.route(`**/v1/tournaments/${tournamentId}/registration`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ registration: { id: registrationId, tournamentId, deckId, powerSnapshot: { source: "leyline", sourceVersion: "adapter/v1", providerAlgorithmVersion: "undeclared", score: 72, inputSummarySha256: "a".repeat(64), computedAt: now, availability: "available", degradationReason: null, responseSha256: "b".repeat(64) }, status: "registered", registeredAt: now } })) }));
  await page.route(`**/v1/tournaments/${tournamentId}/result`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ result })) }));
  await page.route("**/v1/tournaments/history", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{ tournament: registered, registration: { id: registrationId, tournamentId, deckId, powerSnapshot: { source: "leyline", sourceVersion: "adapter/v1", providerAlgorithmVersion: "undeclared", score: 72, inputSummarySha256: "a".repeat(64), computedAt: now, availability: "available", degradationReason: null, responseSha256: "b".repeat(64) }, status: "settled", registeredAt: now }, result }] })) }));
  await page.route("**/v1/tournament-pack-grants", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{ id: "10000000-0000-4000-8000-000000000256", tournamentId, packId: "BRO-BASE", status: "available", createdAt: now, claimedAt: null }] })) }));
  await session(page); await page.goto("/tournaments");
  await expect(page.getByText("服务端赛事结果")).toBeVisible(); await expect(page.getByText("排名 1 · 12 分 · 胜/平/负 3/0/0")).toBeVisible(); await page.getByText("查看 NPC 可公开重放材料").first().click(); await expect(page.getByText("public-npc-seed").first()).toBeVisible(); await expect(page.getByText("补充包 BRO-BASE")).toBeVisible(); await expect(page.getByText("历史赛事")).toBeVisible();
});

test("现实桌仅提交名称；全桌赛果提交/确认由服务端授权并保留失败状态", async ({ page }) => {
  const playerTournament = { id: playerTournamentId, creatorUserId: "10000000-0000-4000-8000-000000000250", mode: "tabletop", name: "周末现实桌", status: "in_progress", ruleVersion: "tournament/v1", createdAt: now, settledAt: null } as const;
  await common(page); await page.route(`**/v1/player-tournaments/${playerTournamentId}`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ tournament: playerTournament })) }));
  await page.route(`**/v1/player-tournaments/${playerTournamentId}/registrations`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{ id: registrationId, tournamentId: playerTournamentId, deckName: "实体 Commander 名称", mode: "tabletop", status: "registered", points: 4, registeredAt: now }] })) }));
  await page.route(`**/v1/player-tournaments/${playerTournamentId}/rounds`, (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(envelope({ items: [{ id: roundId, tournamentId: playerTournamentId, roundNumber: 1, tableNumber: 1, stage: "normal", status: "pending", registrationIds: [registrationId], submittedByUserId: null, confirmedAt: null }] })) }));
  await page.route(`**/v1/player-tournaments/${playerTournamentId}/result`, (route) => route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify(failure("RESOURCE_NOT_FOUND", "尚无结果")) }));
  await page.route(`**/v1/player-tournament-rounds/${roundId}/result`, (route) => route.fulfill({ status: 403, contentType: "application/json", body: JSON.stringify(failure("AUTHORIZATION_DENIED", "只有同桌报名玩家可提交")) }));
  await session(page); await page.goto(`/tournaments/player/${playerTournamentId}`);
  await expect(page.getByText("实体 Commander 名称")).toBeVisible(); await expect(page.getByText("胜 4 分、平局全桌各 1 分、负/弃权/退出 0 分")).toBeVisible(); await page.getByLabel("第 1 轮胜者").selectOption(registrationId); await page.getByRole("button", { name: "提交本轮赛果" }).click(); await expect(page.getByText("只有同桌报名玩家可提交")).toBeVisible();
});
