import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { GrowthService } from "../application/growth-service.js";
import { weekPeriodKey } from "../domain/period.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-growth-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

async function registerPlayer(app: Awaited<ReturnType<typeof createTestApp>>["app"], email: string) {
  const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "成长玩家", password: "correct-horse-battery-staple" } });
  return `Bearer ${response.json().data.accessToken as string}`;
}

async function createArchive(app: Awaited<ReturnType<typeof createTestApp>>["app"], token: string, key: string) {
  const response = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization: token, "idempotency-key": key }, payload: {} });
  expect(response.statusCode).toBe(201);
}

/** 写入一条已结算事实并按 I35B 同步推进任务实例与等级（模拟结算点内嵌调用）。 */
function settleFact(database: ReturnType<typeof openSqliteDatabase>, event: { type: string; aggregateType: string; aggregateId: string; payload: Record<string, unknown>; occurredAt: string }) {
  const eventId = `fact-${Math.random().toString(36).slice(2)}`;
  database.prepare(
    "INSERT INTO fact_events (id, event_type, aggregate_type, aggregate_id, version, payload_json, occurred_at) VALUES (?, ?, ?, ?, 1, ?, ?)"
  ).run(eventId, event.type, event.aggregateType, event.aggregateId, JSON.stringify({ id: eventId, type: event.type, version: 1, occurredAt: event.occurredAt, correlationId: eventId, payload: event.payload }), event.occurredAt);
  new GrowthService(database, "Asia/Shanghai").advanceFromFact(eventId);
  return eventId;
}

describe("I35B 每日/每周任务与等级声望", () => {
  it("任务中心空态含全部定义；事实推进计数型任务到 claimable，领取入账且重放幂等", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "growth-task@example.test");
    await createArchive(app, token, "growth-archive-0001");

    const empty = await app.inject({ method: "GET", url: "/v1/tasks", headers: { authorization: token } });
    expect(empty.statusCode).toBe(200);
    const emptyData = empty.json().data;
    expect(emptyData.daily).toHaveLength(4);
    expect(emptyData.weekly).toHaveLength(2);
    expect(emptyData.pendingRewardCount).toBe(0);
    expect(emptyData.daily.every((instance: { currentValue: number; status: string }) => instance.currentValue === 0 && instance.status === "pending")).toBe(true);

    // 两次 pack.opened 事实（开包任务 target=3 → 仍 pending），一次 npc.trade.settled sell quantity=3。
    const userId = (database.prepare("SELECT id FROM users WHERE email = ?").get("growth-task@example.test") as { id: string }).id;
    settleFact(database, { type: "pack.opened", aggregateType: "pack_opening", aggregateId: "op-0001", payload: { userId, packId: "p", packRuleVersion: "pack/v1", spent: { amount: 100, currency: "GAME_CREDIT" }, received: [{ skuId: "s", quantity: 1 }] }, occurredAt: "2026-08-05T01:00:00.000Z" });
    settleFact(database, { type: "pack.opened", aggregateType: "pack_opening", aggregateId: "op-0002", payload: { userId, packId: "p", packRuleVersion: "pack/v1", spent: { amount: 100, currency: "GAME_CREDIT" }, received: [{ skuId: "s", quantity: 1 }] }, occurredAt: "2026-08-05T02:00:00.000Z" });
    settleFact(database, { type: "npc.trade.settled", aggregateType: "npc_trade", aggregateId: "trade-0001", payload: { tradeId: "trade-0001", userId, skuId: "s", side: "sell", quantity: 3, unitPrice: { amount: 10, currency: "GAME_CREDIT" }, total: { amount: 30, currency: "GAME_CREDIT" }, quoteVersion: "market/v1" }, occurredAt: "2026-08-05T03:00:00.000Z" });

    const center = await app.inject({ method: "GET", url: "/v1/tasks", headers: { authorization: token } });
    const daily = center.json().data.daily as Array<{ definitionId: string; currentValue: number; status: string; id: string }>;
    const openTask = daily.find((instance) => instance.definitionId === "daily-open-3/v1")!;
    expect(openTask).toMatchObject({ currentValue: 2, status: "pending" });
    // npc.sell 卖出事实同时推进 trade(3) 与 sell(1)。
    expect(daily.find((instance) => instance.definitionId === "daily-trade-10/v1")).toMatchObject({ currentValue: 3, status: "pending" });
    expect(daily.find((instance) => instance.definitionId === "daily-sell-1/v1")).toMatchObject({ currentValue: 1, status: "claimable" });
    expect(center.json().data.pendingRewardCount).toBe(1);

    // 领取 npc.sell 任务奖励：入账 + 状态机推进 + 幂等重放。
    const sellInstanceId = daily.find((instance) => instance.definitionId === "daily-sell-1/v1")!.id;
    const claim = { method: "POST" as const, url: `/v1/tasks/${sellInstanceId}/claim`, headers: { authorization: token, "idempotency-key": "growth-claim-0001" }, payload: {} };
    const [first, replay] = await Promise.all([app.inject(claim), app.inject(claim)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    expect((first.statusCode === 201 ? first : replay).json().data).toMatchObject({ instanceId: sellInstanceId, status: "claimed", reward: { amount: 80, currency: "GAME_CREDIT" } });
    const account = database.prepare("SELECT total_amount, available_amount FROM accounts WHERE user_id = ?").get(userId) as { total_amount: number; available_amount: number };
    // 10000 初始 + 交易事实同步等级(10000 净资产 → 等级2)一次性升级奖励 200 + 任务奖励 80。
    expect(account.available_amount).toBe(10_000 + 200 + 80);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE reason = 'task_reward'").get()).toEqual({ count: 1 });
    // 已领取实例冻结：再次推进同一任务不再计数，重复领取拒绝。
    settleFact(database, { type: "npc.trade.settled", aggregateType: "npc_trade", aggregateId: "trade-0002", payload: { tradeId: "trade-0002", userId, skuId: "s", side: "sell", quantity: 5, unitPrice: { amount: 10, currency: "GAME_CREDIT" }, total: { amount: 50, currency: "GAME_CREDIT" }, quoteVersion: "market/v1" }, occurredAt: "2026-08-05T04:00:00.000Z" });
    const row = database.prepare("SELECT current_value, status FROM task_instances WHERE id = ?").get(sellInstanceId) as { current_value: number; status: string };
    expect(row).toEqual({ current_value: 1, status: "claimed" });
    const again = await app.inject({ method: "POST", url: `/v1/tasks/${sellInstanceId}/claim`, headers: { authorization: token, "idempotency-key": "growth-claim-0002" }, payload: {} });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    await app.close(); database.close();
  });

  it("跨自然日周期键重置：昨日进度不累计到今日，每周任务按 ISO 周推进；越权与未达标领取拒绝", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "growth-period@example.test");
    await createArchive(app, token, "growth-archive-0002");
    const userId = (database.prepare("SELECT id FROM users WHERE email = ?").get("growth-period@example.test") as { id: string }).id;

    settleFact(database, { type: "pack.opened", aggregateType: "pack_opening", aggregateId: "op-0003", payload: { userId, packId: "p", packRuleVersion: "pack/v1", spent: { amount: 100, currency: "GAME_CREDIT" }, received: [{ skuId: "s", quantity: 1 }] }, occurredAt: "2026-08-04T00:30:00.000Z" });
    settleFact(database, { type: "pack.opened", aggregateType: "pack_opening", aggregateId: "op-0004", payload: { userId, packId: "p", packRuleVersion: "pack/v1", spent: { amount: 100, currency: "GAME_CREDIT" }, received: [{ skuId: "s", quantity: 1 }] }, occurredAt: "2026-08-05T01:00:00.000Z" });
    // 再造一条今日 NPC 卖出事实，产生一条可领取实例（供越权检查）。
    settleFact(database, { type: "npc.trade.settled", aggregateType: "npc_trade", aggregateId: "trade-0003", payload: { tradeId: "trade-0003", userId, skuId: "s", side: "sell", quantity: 1, unitPrice: { amount: 10, currency: "GAME_CREDIT" }, total: { amount: 10, currency: "GAME_CREDIT" }, quoteVersion: "market/v1" }, occurredAt: "2026-08-05T02:00:00.000Z" });
    // 周二(2026-08-04)与周三(2026-08-05)属于同一 ISO 周（2026-W32）。
    expect(weekPeriodKey(new Date("2026-08-04T00:00:00.000Z"), "Asia/Shanghai")).toBe("2026-W32");
    expect(weekPeriodKey(new Date("2026-08-05T00:00:00.000Z"), "Asia/Shanghai")).toBe("2026-W32");

    const center = await app.inject({ method: "GET", url: "/v1/tasks", headers: { authorization: token } });
    const daily = center.json().data.daily as Array<{ definitionId: string; currentValue: number; periodKey: string }>;
    expect(daily.find((instance) => instance.definitionId === "daily-open-3/v1")).toMatchObject({ currentValue: 1, periodKey: "2026-08-05" });
    // 昨日（2026-08-04）的实例独立保留，不参与今日展示。
    const yesterdayRows = database.prepare("SELECT period_key FROM task_instances WHERE definition_id = 'daily-open-3/v1' AND period_key = '2026-08-04'").all() as Array<{ period_key: string }>;
    expect(yesterdayRows).toHaveLength(1);

    // 越权：另一玩家不能领取他人已达标实例。
    const otherToken = await registerPlayer(app, "growth-other@example.test");
    await createArchive(app, otherToken, "growth-archive-0003");
    const sellInstances = database.prepare("SELECT id FROM task_instances WHERE user_id = ? AND status = 'claimable'").all(userId) as Array<{ id: string }>;
    const otherClaim = await app.inject({ method: "POST", url: `/v1/tasks/${sellInstances[0]!.id}/claim`, headers: { authorization: otherToken, "idempotency-key": "growth-claim-other-0001" }, payload: {} });
    expect(otherClaim.statusCode).toBe(404);
    // 未达标实例不可领取。
    const pendingId = database.prepare("SELECT id FROM task_instances WHERE user_id = ? AND definition_id = 'daily-open-3/v1' AND period_key = '2026-08-05'").get(userId) as { id: string };
    const premature = await app.inject({ method: "POST", url: `/v1/tasks/${pendingId.id}/claim`, headers: { authorization: token, "idempotency-key": "growth-claim-early-0001" }, payload: {} });
    expect(premature.statusCode).toBe(409);
    expect(premature.json().error.code).toBe("RULE_VIOLATION");
    await app.close(); database.close();
  });

  it("状态型指标取峰值不回退；等级随经验上升发放一次性奖励且不重复，能力随等级生效", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "growth-level@example.test");
    await createArchive(app, token, "growth-archive-0004");
    const userId = (database.prepare("SELECT id FROM users WHERE email = ?").get("growth-level@example.test") as { id: string }).id;

    // 造一条可交易报价与持仓，再开包触发 collection.value（状态型 max 语义）。
    const now = "2026-08-05T00:00:00.000Z";
    database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'I35', 'I35B 测试系列', 'manual-test', ?)").run("10000000-0000-4000-8000-000000000351", now);
    database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'I35B 测试卡', '1', 'common', '{}', 'manual-test', 'I35B', 1, ?, ?)").run("20000000-0000-4000-8000-000000000351", "10000000-0000-4000-8000-000000000351", now, now);
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'I35B', 1, ?, ?)").run("30000000-0000-4000-8000-000000000351", "20000000-0000-4000-8000-000000000351", now, now);
    database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run("40000000-0000-4000-8000-000000000351", "a".repeat(64), "b".repeat(64), now, now);
    database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 100, 'priced', NULL, ?, ?)").run("50000000-0000-4000-8000-000000000351", "40000000-0000-4000-8000-000000000351", "30000000-0000-4000-8000-000000000351", now, now);
    database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'fixture', 'market/v1', 100, 3000, 3000, 3000, 0, 0, '{}', '[]', ?, '2099-01-01T00:00:00.000Z')").run("60000000-0000-4000-8000-000000000351", "30000000-0000-4000-8000-000000000351", "50000000-0000-4000-8000-000000000351", now);
    database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, updated_at) VALUES (?, ?, ?, 2, 2, 0, 0, 100, 6000, ?)").run("70000000-0000-4000-8000-000000000351", userId, "30000000-0000-4000-8000-000000000351", now);

    // 两次事实：collection.value 以 max 收敛到 6000（2×3000），不累加。
    settleFact(database, { type: "pack.opened", aggregateType: "pack_opening", aggregateId: "op-0005", payload: { userId, packId: "p", packRuleVersion: "pack/v1", spent: { amount: 100, currency: "GAME_CREDIT" }, received: [{ skuId: "30000000-0000-4000-8000-000000000351", quantity: 1 }] }, occurredAt: "2026-08-05T05:00:00.000Z" });
    settleFact(database, { type: "pack.opened", aggregateType: "pack_opening", aggregateId: "op-0006", payload: { userId, packId: "p", packRuleVersion: "pack/v1", spent: { amount: 100, currency: "GAME_CREDIT" }, received: [{ skuId: "30000000-0000-4000-8000-000000000351", quantity: 1 }] }, occurredAt: "2026-08-05T06:00:00.000Z" });
    const collectionRow = database.prepare("SELECT current_value, status FROM task_instances WHERE user_id = ? AND definition_id = 'daily-collection-2000/v1' AND period_key = '2026-08-05'").get(userId) as { current_value: number; status: string };
    expect(collectionRow).toEqual({ current_value: 6000, status: "claimable" });

    // 等级：净资产(10000 初始) + 持仓 6000 + 交易/开包经验 → 等级 2，发放一次性升级奖励。
    const growth = await app.inject({ method: "GET", url: "/v1/growth", headers: { authorization: token } });
    expect(growth.statusCode).toBe(200);
    const profile = growth.json().data;
    expect(profile).toMatchObject({ level: 2, title: "资深收藏家", capabilities: { npcDailyTradeMultiplier: 1, bulkPackMax: 50 } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE reason = 'level_up_reward'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT total_amount, available_amount FROM accounts WHERE user_id = ?").get(userId)).toEqual({ total_amount: 10_200, available_amount: 10_200 });
    // 再次同步不重复发奖。
    new GrowthService(database, "Asia/Shanghai").syncLevelForUser(userId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE reason = 'level_up_reward'").get()).toEqual({ count: 1 });
    await app.close(); database.close();
  });

  it("无存档玩家读取任务/等级返回 409", async () => {
    const { app, database } = await createTestApp();
    const token = await registerPlayer(app, "growth-noarchive@example.test");
    const tasks = await app.inject({ method: "GET", url: "/v1/tasks", headers: { authorization: token } });
    expect(tasks.statusCode).toBe(409);
    const growth = await app.inject({ method: "GET", url: "/v1/growth", headers: { authorization: token } });
    expect(growth.statusCode).toBe(409);
    await app.close(); database.close();
  });
});
