import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { PackService } from "../application/pack-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-packs-i33b-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

async function authorization(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "i33b-packs@example.test", displayName: "I33B 开包玩家", password: "correct-horse-battery-staple" } });
  return `Bearer ${response.json().data.accessToken as string}`;
}

async function createArchive(app: Awaited<ReturnType<typeof createTestApp>>["app"], token: string, key = "i33b-archive-key-01") {
  const response = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization: token, "idempotency-key": key }, payload: {} });
  expect(response.statusCode).toBe(201);
}

function seedCatalogAndPacks(database: ReturnType<typeof openSqliteDatabase>) {
  const now = "2026-08-04T00:00:00.000Z";
  const setId = "10000000-0000-4000-8000-000000000061";
  const setId2 = "10000000-0000-4000-8000-000000000062";
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'I33', 'I33B 测试系列', 'manual-test', ?)").run(setId, now);
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'I34', 'I33B 第二系列', 'manual-test', ?)").run(setId2, now);
  // 单 SKU 候选池 + 2 抽：无论种子如何都稳定开出同一张卡 quantity=2，保证断言确定性。
  const printingId = "20000000-0000-4000-8000-000000000061";
  const skuId = "30000000-0000-4000-8000-000000000061";
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'I33B 测试卡', '1', 'common', '{}', 'manual-test', 'I33B', 1, ?, ?)").run(printingId, setId, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 0, 'manual-test', 'I33B', 1, ?, ?)").run(skuId, printingId, now, now);
  // 同系列第二张卡（供完成度 = 1/2 = 5000）。
  const printingId2 = "20000000-0000-4000-8000-000000000062";
  const skuId2 = "30000000-0000-4000-8000-000000000062";
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'I33B 测试卡二', '2', 'common', '{}', 'manual-test', 'I33B', 1, ?, ?)").run(printingId2, setId, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 0, 'manual-test', 'I33B', 1, ?, ?)").run(skuId2, printingId2, now, now);
  const otherPrinting = "20000000-0000-4000-8000-000000000070";
  const otherSku = "30000000-0000-4000-8000-000000000070";
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'I33B 异系列卡', '1', 'common', '{}', 'manual-test', 'I33B', 1, ?, ?)").run(otherPrinting, setId2, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 0, 'manual-test', 'I33B', 1, ?, ?)").run(otherSku, otherPrinting, now, now);

  const activePackId = "40000000-0000-4000-8000-000000000061";
  const definition = JSON.stringify({
    version: "pack/v1",
    pools: [
      { id: "common", rarity: "common", candidates: [{ skuId, weight: 1 }] }
    ],
    slots: [{ id: "regular", draws: 2, poolWeights: [{ poolId: "common", weight: 1 }] }]
  });
  database.prepare("INSERT INTO booster_packs (id, code, name, description, price_amount, enabled, disabled_reason, active_rule_version, created_at, updated_at) VALUES (?, 'I33-01', 'I33B 测试补充包', NULL, 100, 1, NULL, 'pack/v1', ?, ?)").run(activePackId, now, now);
  database.prepare("INSERT INTO booster_pack_rules (id, pack_id, version, definition_json, created_at, retired_at) VALUES (?, ?, 'pack/v1', ?, ?, NULL)").run("50000000-0000-4000-8000-000000000061", activePackId, definition, now);
  return { activePackId, skuIds: [skuId], setId, otherSku };
}

describe("I33B 开包 DTO 增强与批量开包", () => {
  it("单包返回新卡标记、系列完成度快照与本包总成本/总价值；重复开包标为非新卡", async () => {
    const { app, database } = await createTestApp();
    const { activePackId } = seedCatalogAndPacks(database);
    const token = await authorization(app);
    await createArchive(app, token);
    const openRequest = {
      method: "POST" as const,
      url: `/v1/packs/${activePackId}/open`,
      headers: { authorization: token, "idempotency-key": "i33b-open-key-0001" },
      payload: { ruleVersion: "pack/v1" }
    };
    const [first] = await Promise.all([app.inject(openRequest), app.inject(openRequest)]);
    expect(first.statusCode).toBe(201);
    const opening = (first.json() as { data: { opening: { totalCost: { amount: number; currency: string }; totalGameValue: { amount: number; currency: string } | null; profitLoss: { priceStatus: string }; received: Array<{ skuId: string; quantity: number; cost: { amount: number }; isNewToCollection: boolean; collectionProgressAfter: { setCode: string; collectedSkuCount: number; totalSkuCount: number; completionBasisPoints: number } }> } } }).data.opening;
    expect(opening.totalCost).toEqual({ amount: 100, currency: "GAME_CREDIT" });
    expect(opening.totalGameValue).toBeNull();
    expect(opening.profitLoss.priceStatus).toBe("unavailable_until_i17");
    const receivedCards = opening.received;
    // 单 SKU 池 2 抽：稳定收 1 个 SKU × 2 张，成本分摊 = 100。
    expect(receivedCards).toHaveLength(1);
    expect(receivedCards[0]).toMatchObject({ quantity: 2, isNewToCollection: true, cost: { amount: 100, currency: "GAME_CREDIT" } });
    expect(receivedCards[0]?.collectionProgressAfter).toEqual({ setCode: "I33", collectedSkuCount: 1, totalSkuCount: 2, completionBasisPoints: 5000 });
    expect(receivedCards.reduce((sum: number, card: { cost: { amount: number } }) => sum + card.cost.amount, 0)).toBe(100);

    // 第二次开包：同一 SKU 已持有，标记为非新卡，完成度不变。
    const second = await app.inject({ ...openRequest, headers: { authorization: token, "idempotency-key": "i33b-open-key-0002" } });
    expect(second.statusCode).toBe(201);
    const secondOpening = second.json().data.opening;
    expect(secondOpening.received.every((card: { isNewToCollection: boolean }) => card.isNewToCollection === false)).toBe(true);
    expect(secondOpening.received[0].collectionProgressAfter).toEqual({ setCode: "I33", collectedSkuCount: 1, totalSkuCount: 2, completionBasisPoints: 5000 });
    await app.close(); database.close();
  });

  it("批量开包 10 包：单事务扣款、逐包结算、汇总稀有度/总成本/新增 SKU 数，且重放不重复扣款", async () => {
    const { app, database } = await createTestApp();
    const { activePackId } = seedCatalogAndPacks(database);
    const token = await authorization(app);
    await createArchive(app, token, "i33b-bulk-archive-01");
    const bulkRequest = {
      method: "POST" as const,
      url: `/v1/packs/${activePackId}/bulk`,
      headers: { authorization: token, "idempotency-key": "i33b-bulk-key-0001" },
      payload: { ruleVersion: "pack/v1", count: 10 }
    };
    const [first, replay] = await Promise.all([app.inject(bulkRequest), app.inject(bulkRequest)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const bulk = (first.statusCode === 201 ? first : replay).json().data.bulk;
    expect(bulk.summary).toMatchObject({ packId: activePackId, count: 10, totalCost: { amount: 1000, currency: "GAME_CREDIT" }, newSkuCount: 1 });
    expect(bulk.summary.rarityCounts).toEqual([{ rarity: "common", quantity: 20 }]);
    expect(bulk.openings).toHaveLength(10);
    expect(bulk.openings.every((opening: { totalCost: { amount: number } }) => opening.totalCost.amount === 100)).toBe(true);
    // 全部唯一卡 10 包 × 2 张都来自同一个 1 SKU 候选池；新增 SKU 数为 1（开包前未持有）。
    expect(database.prepare("SELECT total_amount, available_amount FROM accounts").get()).toEqual({ total_amount: 9000, available_amount: 9000 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM pack_openings").get()).toEqual({ count: 10 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fact_events WHERE event_type = 'pack.opened'").get()).toEqual({ count: 10 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_holdings WHERE quantity > 0").get()).toEqual({ count: 1 });

    // 非法数量被 HTTP 边界拒绝，不消耗幂等键。
    const invalid = await app.inject({ ...bulkRequest, payload: { ruleVersion: "pack/v1", count: 7 }, headers: { authorization: token, "idempotency-key": "i33b-bulk-invalid-01" } });
    expect(invalid.statusCode).toBe(400);
    await app.close(); database.close();
  });

  it("I35B 等级能力：等级 1 批量开包超过 10 包被拒绝，等级 2 解锁 50 包", async () => {
    const { app, database } = await createTestApp();
    const { activePackId } = seedCatalogAndPacks(database);
    const token = await authorization(app);
    await createArchive(app, token, "i35b-bulk-gate-archive-01");
    const userId = (database.prepare("SELECT id FROM users WHERE email = 'i33b-packs@example.test'").get() as { id: string }).id;
    // 等级 1（无 player_growth 行）：count=50 被服务端能力门禁拒绝。
    const denied = await app.inject({
      method: "POST",
      url: `/v1/packs/${activePackId}/bulk`,
      headers: { authorization: token, "idempotency-key": "i35b-bulk-gate-low-0001" },
      payload: { ruleVersion: "pack/v1", count: 50 }
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe("RULE_VIOLATION");
    expect(database.prepare("SELECT COUNT(*) AS count FROM pack_openings").get()).toEqual({ count: 0 });
    // 提升到等级 2（bulkPackMax=50）后可执行（余额充足时成功，这里以余额断言到达结算路径）。
    database.prepare("INSERT INTO player_growth (user_id, total_xp, level, title, peak_net_worth_amount, rule_version, updated_at) VALUES (?, 200, 2, '资深收藏家', 10000, 'level/v1', ?)").run(userId, "2026-08-05T00:00:00.000Z");
    database.prepare("UPDATE accounts SET total_amount = 500, available_amount = 500").run();
    const lowBalance = await app.inject({
      method: "POST",
      url: `/v1/packs/${activePackId}/bulk`,
      headers: { authorization: token, "idempotency-key": "i35b-bulk-gate-ok-0001" },
      payload: { ruleVersion: "pack/v1", count: 50 }
    });
    expect(lowBalance.json()).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_BALANCE" } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM pack_openings").get()).toEqual({ count: 0 });
    await app.close(); database.close();
  });

  it("余额不足或库存写入故障时整批回滚，不留下半完成开包", async () => {
    const { app, database } = await createTestApp();
    const { activePackId } = seedCatalogAndPacks(database);
    const token = await authorization(app);
    await createArchive(app, token, "i33b-bulk-archive-02");
    // I35B（F5）：批量开包上限随等级提升，count=50 需要等级 2（bulkPackMax=50）。
    const userId = (database.prepare("SELECT id FROM users WHERE email = 'i33b-packs@example.test'").get() as { id: string }).id;
    database.prepare("INSERT INTO player_growth (user_id, total_xp, level, title, peak_net_worth_amount, rule_version, updated_at) VALUES (?, 200, 2, '资深收藏家', 10000, 'level/v1', ?)").run(userId, "2026-08-05T00:00:00.000Z");
    database.prepare("UPDATE accounts SET total_amount = 500, available_amount = 500").run();
    const lowBalance = await app.inject({
      method: "POST",
      url: `/v1/packs/${activePackId}/bulk`,
      headers: { authorization: token, "idempotency-key": "i33b-bulk-low-0001" },
      payload: { ruleVersion: "pack/v1", count: 50 }
    });
    expect(lowBalance.json()).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_BALANCE" } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM pack_openings").get()).toEqual({ count: 0 });
    database.prepare("UPDATE accounts SET total_amount = 10000, available_amount = 10000").run();
    database.exec("CREATE TRIGGER fail_i33b_inventory BEFORE INSERT ON inventory_entries WHEN NEW.reason = 'pack_opened' BEGIN SELECT RAISE(ABORT, 'forced inventory failure'); END");
    const failed = await app.inject({
      method: "POST",
      url: `/v1/packs/${activePackId}/bulk`,
      headers: { authorization: token, "idempotency-key": "i33b-bulk-fail-0001" },
      payload: { ruleVersion: "pack/v1", count: 10 }
    });
    expect(failed.statusCode).toBe(500);
    expect(database.prepare("SELECT total_amount, available_amount FROM accounts").get()).toEqual({ total_amount: 10000, available_amount: 10000 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM pack_openings").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fact_events").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_holdings WHERE quantity > 0").get()).toEqual({ count: 0 });
    await app.close(); database.close();
  });

  it("限时 offer：窗口内按折扣价可购买，窗口外与服务端到期判定拒绝", async () => {
    const { app, database } = await createTestApp();
    const { activePackId } = seedCatalogAndPacks(database);
    const token = await authorization(app);
    await createArchive(app, token, "i33b-offer-archive-01");

    const service = new PackService(database, () => "a".repeat(64));
    const userId = (database.prepare("SELECT id FROM users WHERE email = 'i33b-packs@example.test'").get() as { id: string }).id;
    // 远未来的窗口（真实服务时间之前）：预览与购买被服务端拒绝（未开始）。
    const created = service.createOffer({ packId: activePackId, name: "限时折扣", description: null, discountBps: 8000, startsAt: "2099-01-01T00:00:00.000Z", endsAt: "2099-12-31T00:00:00.000Z", actorId: null, now: "2026-08-04T00:00:00.000Z" });
    expect(created).toEqual(expect.objectContaining({ offer: expect.objectContaining({ discountBps: 8000, status: "scheduled" }) }));
    const scheduled = await app.inject({ method: "GET", url: `/v1/store/packs/${activePackId}/purchase-preview`, headers: { authorization: token } });
    expect(scheduled.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_CONFLICT" } });
    const scheduledOpen = service.openForPurchase({ userId, packId: activePackId, ruleVersion: "pack/v1", idempotencyKey: "i33b-offer-scheduled-01", requestFingerprint: "a".repeat(64), requestId: "req-i33b-offer-01", now: new Date("2026-08-04T00:00:00.000Z") });
    expect(scheduledOpen.state === "completed" && scheduledOpen.response.ok === false && scheduledOpen.response.error.code).toBe("RESOURCE_CONFLICT");

    // 结束该窗口后立即建一个覆盖当前真实时间的窗口（折扣 80%）：HTTP 预览显示折扣价 80，开包按 80 结算。
    service.endOffer((created as { offer: { id: string } }).offer.id, "2026-08-04T01:00:00.000Z");
    service.createOffer({ packId: activePackId, name: "限时折扣", description: null, discountBps: 8000, startsAt: "2000-01-01T00:00:00.000Z", endsAt: "2099-12-31T00:00:00.000Z", actorId: null, now: "2026-08-04T02:00:00.000Z" });
    const active = await app.inject({ method: "GET", url: `/v1/store/packs/${activePackId}/purchase-preview`, headers: { authorization: token } });
    expect(active.json()).toMatchObject({ ok: true, data: { preview: { cost: { amount: 80, currency: "GAME_CREDIT" } } } });
    const opened = service.openForPurchase({ userId, packId: activePackId, ruleVersion: "pack/v1", idempotencyKey: "i33b-offer-open-01", requestFingerprint: "a".repeat(64), requestId: "req-i33b-offer-02", now: new Date("2026-08-06T00:00:00.000Z") });
    expect(opened.state === "completed" && opened.statusCode === 201).toBe(true);
    const account = database.prepare("SELECT total_amount, available_amount FROM accounts").get() as { total_amount: number; available_amount: number };
    expect(account.available_amount).toBe(10000 - 80);

    // 到期后 expireOffers 批量结束窗口，服务端状态为 ended。
    service.expireOffers("2099-12-31T23:59:59.000Z");
    const endedNow = service.offerOf(activePackId, "2099-12-31T23:59:59.000Z");
    expect(endedNow?.status).toBe("ended");
    const afterEndOpen = service.openForPurchase({ userId, packId: activePackId, ruleVersion: "pack/v1", idempotencyKey: "i33b-offer-ended-01", requestFingerprint: "a".repeat(64), requestId: "req-i33b-offer-03", now: new Date("2100-01-01T00:00:00.000Z") });
    expect(afterEndOpen.state === "completed" && afterEndOpen.response.ok === false && afterEndOpen.response.error.code).toBe("RESOURCE_CONFLICT");
    await app.close(); database.close();
  });
});
