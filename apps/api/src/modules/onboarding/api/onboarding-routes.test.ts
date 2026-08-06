import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { OnboardingService } from "../application/onboarding-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-onboarding-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

async function registerPlayer(app: Awaited<ReturnType<typeof createTestApp>>["app"], email: string) {
  const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "引导玩家", password: "correct-horse-battery-staple" } });
  return `Bearer ${response.json().data.accessToken as string}`;
}

async function createArchive(app: Awaited<ReturnType<typeof createTestApp>>["app"], token: string, key: string) {
  const response = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization: token, "idempotency-key": key }, payload: {} });
  expect(response.statusCode).toBe(201);
}

/** 写入一条已结算事实并按 I36B 同步推进新手引导（模拟结算点内嵌调用）。 */
function settleFact(database: ReturnType<typeof openSqliteDatabase>, event: { type: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; occurredAt: string }) {
  const eventId = `onb-fact-${Math.random().toString(36).slice(2)}`;
  database.prepare(
    "INSERT INTO fact_events (id, event_type, aggregate_type, aggregate_id, version, payload_json, occurred_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
  ).run(eventId, event.type, event.aggregateType, event.aggregateId, JSON.stringify({ id: eventId, type: event.type, version: 1, occurredAt: event.occurredAt, correlationId: eventId, payload: event.payload }), event.occurredAt);
  new OnboardingService(database).advanceFromFact(eventId);
  return eventId;
}

/** 直接造一条每日工作资金领取记录（模拟 daily.rollover 开放 + claim 的已结算事实）。 */
function seedWorkFundsClaim(database: ReturnType<typeof openSqliteDatabase>, userId: string, rolloverId: string) {
  database.prepare("INSERT INTO daily_work_funding_claims (id, rollover_id, user_id, natural_date, rule_version, amount, idempotency_key, claimed_at) VALUES (?, ?, ?, '2026-08-05', 'daily-work-funds/v1', 1000, ?, '2026-08-05T00:00:00.000Z')").run(`dwf-${Math.random().toString(36).slice(2)}`, rolloverId, userId, `key-${Math.random().toString(36).slice(2)}`);
}

/** 最小目录夹具：card_sets/card_printings/card_skus 各一行（供 inventory_holdings 外键引用）。 */
function seedCatalog(database: ReturnType<typeof openSqliteDatabase>): string {
  const now = "2026-08-05T00:00:00.000Z";
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'I36', 'I36B 测试系列', 'manual-test', ?)").run("10000000-0000-4000-8000-000000000361", now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'I36B 测试卡', '1', 'common', '{}', 'manual-test', 'I36B', 1, ?, ?)").run("20000000-0000-4000-8000-000000000361", "10000000-0000-4000-8000-000000000361", now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'I36B', 1, ?, ?)").run("30000000-0000-4000-8000-000000000361", "20000000-0000-4000-8000-000000000361", now, now);
  return "30000000-0000-4000-8000-000000000361";
}

describe("I36B 新手引导与首次体验服务端", () => {
  it("初始投影九步待办、创建存档后第一步自动完成；领取工作资金与开包事实自动完成对应步骤", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "onboarding-basic@example.test");
    const userId = (database.prepare("SELECT id FROM users WHERE email = ?").get("onboarding-basic@example.test") as { id: string }).id;
    await createArchive(app, token, "onboarding-archive-0001");

    // 创建存档后第一步 create-archive 由服务端按 accounts 存档快照自动完成（引导第一步即「创建存档」）。
    const initial = await app.inject({ method: "GET", url: "/v1/onboarding", headers: { authorization: token } });
    expect(initial.statusCode).toBe(200);
    const initialData = initial.json().data.onboarding;
    expect(initialData.ruleVersion).toBe("onboarding/v3");
    expect(initialData.steps).toHaveLength(9);
    expect(initialData.completedCount).toBe(1);
    expect(initialData.allCompleted).toBe(false);
    expect(initialData.currentStepId).toBe("claim-work-funds");
    expect(initialData.reward.status).toBe("unavailable");

    // 领取工作资金（先补 rollover 与领取记录，模拟已结算事实）。
    database.prepare("INSERT INTO daily_rollover_runs (id, natural_date, timezone, work_funding_amount, work_funding_rule_version, opened_at) VALUES (?, '2026-08-05', 'Asia/Shanghai', 1000, 'daily-work-funds/v1', '2026-08-05T00:00:00.000Z')").run(`rollover-${Math.random().toString(36).slice(2)}`);
    const rollover = database.prepare("SELECT id FROM daily_rollover_runs WHERE natural_date = '2026-08-05'").get() as { id: string };
    seedWorkFundsClaim(database, userId, rollover.id);

    // 开包事实：完成 open-first-pack（fact 步骤）。
    settleFact(database, { type: "pack.opened", aggregateType: "pack_opening", aggregateId: "onb-op-0001", payload: { userId, packId: "p", packRuleVersion: "pack/v1", spent: { amount: 100, currency: "GAME_CREDIT" }, received: [{ skuId: "s", quantity: 1 }] }, occurredAt: "2026-08-05T01:00:00.000Z" });
    // NPC 交易事实：完成 complete-first-npc-trade（fact 步骤）。
    settleFact(database, { type: "npc.trade.settled", aggregateType: "npc_trade", aggregateId: "onb-trade-0001", payload: { tradeId: "onb-trade-0001", userId, skuId: "s", side: "buy", quantity: 1, unitPrice: { amount: 10, currency: "GAME_CREDIT" }, total: { amount: 10, currency: "GAME_CREDIT" }, quoteVersion: "market/v1" }, occurredAt: "2026-08-05T02:00:00.000Z" });

    const after = await app.inject({ method: "GET", url: "/v1/onboarding", headers: { authorization: token } });
    const data = after.json().data.onboarding;
    const byId = (id: string) => data.steps.find((step: { id: string }) => step.id === id)!;
    // profile 步骤按已结算状态自动完成；首次目标链共 9 步。
    expect(byId("create-archive").completion).toBe("auto");
    expect(byId("claim-work-funds").completion).toBe("auto");
    expect(byId("open-first-pack").completion).toBe("auto");
    expect(byId("complete-first-npc-trade").completion).toBe("auto");
    expect(byId("view-price-history").completion).toBe(null);
    expect(byId("unlock-collection-album").completion).toBe(null);
    expect(byId("first-tournament-registration").completion).toBe(null);
    expect(data.completedCount).toBe(4);
    expect(data.currentStepId).toBe("view-price-history");
    expect(data.reward.status).toBe("unavailable");
    await app.close(); database.close();
  });

  it("查看价格历史（view_event 步骤）提交意图后完成，重复访问与重放幂等", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "onboarding-view@example.test");
    await createArchive(app, token, "onboarding-archive-0002");

    // 路径不匹配：拒绝。
    const mismatch = await app.inject({ method: "POST", url: "/v1/onboarding/steps/view-price-history/view", headers: { authorization: token, "idempotency-key": "onb-view-mismatch-0001" }, payload: { path: "/market" } });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("RULE_VIOLATION");

    // 正确路径：首次记录。
    const view = { method: "POST" as const, url: "/v1/onboarding/steps/view-price-history/view", headers: { authorization: token, "idempotency-key": "onb-view-0001" }, payload: { path: "/market/history" } };
    const [first, replay] = await Promise.all([app.inject(view), app.inject(view)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const result = (first.statusCode === 201 ? first : replay).json().data.onboarding;
    expect(result.steps.find((step: { id: string }) => step.id === "view-price-history")).toMatchObject({ completion: "auto" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM onboarding_events WHERE user_id = (SELECT id FROM users WHERE email = 'onboarding-view@example.test')").get()).toEqual({ count: 1 });

    // 新幂等键重复访问：事件唯一约束去重，不重复计数。
    const again = await app.inject({ method: "POST", url: "/v1/onboarding/steps/view-price-history/view", headers: { authorization: token, "idempotency-key": "onb-view-0002" }, payload: { path: "/market/history" } });
    expect(again.statusCode).toBe(201);
    expect(database.prepare("SELECT COUNT(*) AS count FROM onboarding_events").get()).toEqual({ count: 1 });
    // 重复提交仍返回投影且步骤保持完成。
    expect(again.json().data.onboarding.steps.find((step: { id: string }) => step.id === "view-price-history").completion).toBe("auto");
    await app.close(); database.close();
  });

  it("保存合法卡组、报名与实际查看已结算赛果分别推进独立步骤，非法草稿不能越过组卡教程", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "onboarding-deck-loop@example.test");
    const userId = (database.prepare("SELECT id FROM users WHERE email = ?").get("onboarding-deck-loop@example.test") as { id: string }).id;
    await createArchive(app, token, "onboarding-deck-loop-archive");
    const now = "2026-08-06T01:00:00.000Z";

    database.prepare("INSERT INTO decks (id, user_id, name, format, rule_version, banlist_version, legality_json, created_at, updated_at) VALUES ('onb-invalid-deck', ?, '非法草稿', 'commander-100/v1', 'commander-100/v1', 'commander-banlist/2026-02-09', '{\"valid\":false}', ?, ?)").run(userId, now, now);
    let overview = await app.inject({ method: "GET", url: "/v1/onboarding", headers: { authorization: token } });
    expect(overview.json().data.onboarding.steps.find((step: { id: string }) => step.id === "create-first-deck").completion).toBe(null);

    database.prepare("UPDATE decks SET legality_json = '{\"valid\":true}' WHERE id = 'onb-invalid-deck'").run();
    const prematureView = await app.inject({ method: "POST", url: "/v1/onboarding/steps/finish-first-tournament/view", headers: { authorization: token, "idempotency-key": "onb-result-view-premature" }, payload: { path: "/tournaments/result" } });
    expect(prematureView.statusCode).toBe(409);
    expect(prematureView.json().error.code).toBe("RULE_VIOLATION");
    database.prepare("INSERT INTO player_tournaments (id, creator_user_id, mode, format, name, status, rule_version, random_seed, seed_hash, created_at, settled_at) VALUES ('onb-player-tournament', ?, 'tabletop', 'commander', '引导赛事', 'settled', 'tournament/v1', 'seed', 'hash', ?, ?)").run(userId, now, now);
    database.prepare("INSERT INTO player_tournament_registrations (id, tournament_id, user_id, deck_name, deck_id, power_snapshot_id, status, points, created_at) VALUES ('onb-player-registration', 'onb-player-tournament', ?, '引导卡组', NULL, NULL, 'registered', 4, ?)").run(userId, now);
    database.prepare("INSERT INTO player_tournament_results (id, player_tournament_id, registration_id, rank, points, opponent_points, reward_amount, replay_json, settled_at) VALUES ('onb-player-result', 'onb-player-tournament', 'onb-player-registration', 1, 4, 0, 100, '{}', ?)").run(now);

    overview = await app.inject({ method: "GET", url: "/v1/onboarding", headers: { authorization: token } });
    const byId = (id: string) => overview.json().data.onboarding.steps.find((step: { id: string }) => step.id === id);
    expect(byId("create-first-deck").completion).toBe("auto");
    expect(byId("first-tournament-registration").completion).toBe("auto");
    expect(byId("finish-first-tournament").completion).toBe(null);
    const viewed = await app.inject({ method: "POST", url: "/v1/onboarding/steps/finish-first-tournament/view", headers: { authorization: token, "idempotency-key": "onb-result-view-0001" }, payload: { path: "/tournaments/result" } });
    expect(viewed.statusCode).toBe(201);
    expect(viewed.json().data.onboarding.steps.find((step: { id: string }) => step.id === "finish-first-tournament").completion).toBe("auto");
    await app.close(); database.close();
  });

  it("跳过永久视为已完成；已完成步骤不可重复跳过，未存档玩家只读引导可用但领取奖励 409", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "onboarding-skip@example.test");

    // 未创建存档：只读引导可用（第一步为「创建存档」，下一步即 create-archive），步骤可跳过（老玩家补完路径），但领取奖励要求存档。
    const overview = await app.inject({ method: "GET", url: "/v1/onboarding", headers: { authorization: token } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json().data.onboarding.steps).toHaveLength(9);
    expect(overview.json().data.onboarding.completedCount).toBe(0);
    expect(overview.json().data.onboarding.currentStepId).toBe("create-archive");
    const claimNoArchive = await app.inject({ method: "POST", url: "/v1/onboarding/reward/claim", headers: { authorization: token, "idempotency-key": "onb-reward-noarchive" }, payload: {} });
    expect(claimNoArchive.statusCode).toBe(409);
    expect(claimNoArchive.json().error.code).toBe("RESOURCE_CONFLICT");

    // 跳过 view-price-history。
    const skip = { method: "POST" as const, url: "/v1/onboarding/steps/view-price-history/skip", headers: { authorization: token, "idempotency-key": "onb-skip-0001" }, payload: {} };
    const [first, replay] = await Promise.all([app.inject(skip), app.inject(skip)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const data = (first.statusCode === 201 ? first : replay).json().data.onboarding;
    expect(data.steps.find((step: { id: string }) => step.id === "view-price-history")).toMatchObject({ completion: "skip", skippedAt: expect.any(String) });

    // 已完成步骤不可再次跳过。
    const duplicate = await app.inject({ method: "POST", url: "/v1/onboarding/steps/view-price-history/skip", headers: { authorization: token, "idempotency-key": "onb-skip-0002" }, payload: {} });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("RULE_VIOLATION");

    // 越权：另一玩家不能跳过他人引导进度（不存在的步骤 404）。
    const otherToken = await registerPlayer(app, "onboarding-other@example.test");
    const cross = await app.inject({ method: "POST", url: "/v1/onboarding/steps/nonexistent/skip", headers: { authorization: otherToken, "idempotency-key": "onb-skip-other-0001" }, payload: {} });
    expect(cross.statusCode).toBe(404);
    await app.close(); database.close();
  });

  it("全部步骤完成后奖励 available，领取入账一次且幂等；重放不重复发放", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "onboarding-reward@example.test");
    const userId = (database.prepare("SELECT id FROM users WHERE email = ?").get("onboarding-reward@example.test") as { id: string }).id;
    await createArchive(app, token, "onboarding-archive-0003");

    // 直接完成全部九步（创建存档/领取资金走 profile，开包/NPC 走事实，价格/收藏走访问事件，
    // 组卡、报名与赛果用跳过补全）。
    settleFact(database, { type: "pack.opened", aggregateType: "pack_opening", aggregateId: "onb-op-0002", payload: { userId, packId: "p", packRuleVersion: "pack/v1", spent: { amount: 100, currency: "GAME_CREDIT" }, received: [{ skuId: "s", quantity: 1 }] }, occurredAt: "2026-08-05T03:00:00.000Z" });
    settleFact(database, { type: "npc.trade.settled", aggregateType: "npc_trade", aggregateId: "onb-trade-0002", payload: { tradeId: "onb-trade-0002", userId, skuId: "s", side: "buy", quantity: 1, unitPrice: { amount: 10, currency: "GAME_CREDIT" }, total: { amount: 10, currency: "GAME_CREDIT" }, quoteVersion: "market/v1" }, occurredAt: "2026-08-05T04:00:00.000Z" });
    database.prepare("INSERT INTO daily_rollover_runs (id, natural_date, timezone, work_funding_amount, work_funding_rule_version, opened_at) VALUES (?, '2026-08-05', 'Asia/Shanghai', 1000, 'daily-work-funds/v1', '2026-08-05T00:00:00.000Z')").run(`rollover-${Math.random().toString(36).slice(2)}`);
    const rollover = database.prepare("SELECT id FROM daily_rollover_runs WHERE natural_date = '2026-08-05'").get() as { id: string };
    seedWorkFundsClaim(database, userId, rollover.id);
    // 持仓（unlock-collection-album profile 步骤）与报名（first-tournament-registration profile 步骤）：
    // 前者造一条库存持有；报名步骤用跳过补全。
    const skuId = seedCatalog(database);
    database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, updated_at) VALUES (?, ?, ?, 1, 1, 0, 0, 100, 100, ?)").run(`ih-${Math.random().toString(36).slice(2)}`, userId, skuId, "2026-08-05T00:00:00.000Z");
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/view-price-history/view", headers: { authorization: token, "idempotency-key": "onb-reward-view-0001" }, payload: { path: "/market/history" } });
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/unlock-collection-album/view", headers: { authorization: token, "idempotency-key": "onb-reward-album-0001" }, payload: { path: "/collection/album" } });
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/create-first-deck/skip", headers: { authorization: token, "idempotency-key": "onb-reward-skip-deck-0001" }, payload: {} });
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/first-tournament-registration/skip", headers: { authorization: token, "idempotency-key": "onb-reward-skip-0001" }, payload: {} });
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/finish-first-tournament/skip", headers: { authorization: token, "idempotency-key": "onb-reward-skip-result-0001" }, payload: {} });

    const ready = await app.inject({ method: "GET", url: "/v1/onboarding", headers: { authorization: token } });
    const readyData = ready.json().data.onboarding;
    expect(readyData.completedCount).toBe(9);
    expect(readyData.allCompleted).toBe(true);
    expect(readyData.currentStepId).toBe(null);
    expect(readyData.reward.status).toBe("available");

    // 领取：并发同键只入账一次；完成后状态 claimed。
    const claim = { method: "POST" as const, url: "/v1/onboarding/reward/claim", headers: { authorization: token, "idempotency-key": "onb-reward-claim-0001" }, payload: {} };
    const [first, replay] = await Promise.all([app.inject(claim), app.inject(claim)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const claimData = (first.statusCode === 201 ? first : replay).json().data.reward;
    expect(claimData).toMatchObject({ status: "claimed", reward: { amount: 500, currency: "GAME_CREDIT" } });
    // 初始 10000 + 完成任务与等级无关，只核对入账。
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE reason = 'onboarding_reward'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM onboarding_reward_grants").get()).toEqual({ count: 1 });

    // 新幂等键重复领取：已领取拒绝。
    const again = await app.inject({ method: "POST", url: "/v1/onboarding/reward/claim", headers: { authorization: token, "idempotency-key": "onb-reward-claim-0002" }, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    // 未完成全部步骤不可领取。
    const incompleteToken = await registerPlayer(app, "onboarding-incomplete@example.test");
    await createArchive(app, incompleteToken, "onboarding-archive-0004");
    const premature = await app.inject({ method: "POST", url: "/v1/onboarding/reward/claim", headers: { authorization: incompleteToken, "idempotency-key": "onb-reward-premature-0001" }, payload: {} });
    expect(premature.statusCode).toBe(409);
    expect(premature.json().error.code).toBe("RULE_VIOLATION");
    await app.close(); database.close();
  });

  it("玩家首页待办在引导未完成时携带 continue_onboarding，完成后消失", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "onboarding-dashboard@example.test");
    const userId = (database.prepare("SELECT id FROM users WHERE email = ?").get("onboarding-dashboard@example.test") as { id: string }).id;
    await createArchive(app, token, "onboarding-archive-0005");

    const overview = await app.inject({ method: "GET", url: "/v1/dashboard", headers: { authorization: token } });
    expect(overview.json().data.overview.todos).toEqual(expect.arrayContaining([{ id: "continue_onboarding", label: "继续新手引导", href: "/onboarding" }]));

    // 直接完成全部步骤并领取奖励后，待办消失。
    settleFact(database, { type: "pack.opened", aggregateType: "pack_opening", aggregateId: "onb-op-0003", payload: { userId, packId: "p", packRuleVersion: "pack/v1", spent: { amount: 100, currency: "GAME_CREDIT" }, received: [{ skuId: "s", quantity: 1 }] }, occurredAt: "2026-08-05T05:00:00.000Z" });
    settleFact(database, { type: "npc.trade.settled", aggregateType: "npc_trade", aggregateId: "onb-trade-0003", payload: { tradeId: "onb-trade-0003", userId, skuId: "s", side: "buy", quantity: 1, unitPrice: { amount: 10, currency: "GAME_CREDIT" }, total: { amount: 10, currency: "GAME_CREDIT" }, quoteVersion: "market/v1" }, occurredAt: "2026-08-05T06:00:00.000Z" });
    database.prepare("INSERT INTO daily_rollover_runs (id, natural_date, timezone, work_funding_amount, work_funding_rule_version, opened_at) VALUES (?, '2026-08-05', 'Asia/Shanghai', 1000, 'daily-work-funds/v1', '2026-08-05T00:00:00.000Z')").run(`rollover-${Math.random().toString(36).slice(2)}`);
    const rollover = database.prepare("SELECT id FROM daily_rollover_runs WHERE natural_date = '2026-08-05'").get() as { id: string };
    seedWorkFundsClaim(database, userId, rollover.id);
    const skuId = seedCatalog(database);
    database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, updated_at) VALUES (?, ?, ?, 1, 1, 0, 0, 100, 100, ?)").run(`ih-${Math.random().toString(36).slice(2)}`, userId, skuId, "2026-08-05T00:00:00.000Z");
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/view-price-history/view", headers: { authorization: token, "idempotency-key": "onb-dash-view-0001" }, payload: { path: "/market/history" } });
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/unlock-collection-album/view", headers: { authorization: token, "idempotency-key": "onb-dash-album-0001" }, payload: { path: "/collection/album" } });
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/create-first-deck/skip", headers: { authorization: token, "idempotency-key": "onb-dash-skip-deck-0001" }, payload: {} });
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/first-tournament-registration/skip", headers: { authorization: token, "idempotency-key": "onb-dash-skip-0001" }, payload: {} });
    await app.inject({ method: "POST", url: "/v1/onboarding/steps/finish-first-tournament/skip", headers: { authorization: token, "idempotency-key": "onb-dash-skip-result-0001" }, payload: {} });
    await app.inject({ method: "POST", url: "/v1/onboarding/reward/claim", headers: { authorization: token, "idempotency-key": "onb-dash-claim-0001" }, payload: {} });

    const after = await app.inject({ method: "GET", url: "/v1/dashboard", headers: { authorization: token } });
    expect(after.json().data.overview.todos).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "continue_onboarding" })]));
    await app.close(); database.close();
  });
});
