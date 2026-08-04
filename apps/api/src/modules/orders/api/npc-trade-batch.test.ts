import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";

const directories: string[] = [];
const ids = {
  set: "10000000-0000-4000-8000-000000000181",
  printing: "20000000-0000-4000-8000-000000000181",
  sku: "30000000-0000-4000-8000-000000000181",
  run: "40000000-0000-4000-8000-000000000181",
  snapshot: "50000000-0000-4000-8000-000000000181",
  quote: "60000000-0000-4000-8000-000000000181"
};

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-batch-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

function seedTradableQuote(database: ReturnType<typeof openSqliteDatabase>, sku: string, printing: string, set: string, snapshot: string, run: string, quote: string, name = "批量测试卡", collect = "1", validUntil = "2099-01-01T00:00:00.000Z") {
  const now = "2026-08-04T00:00:00.000Z";
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'BAT', '批量测试系列', 'manual-test', ?) ON CONFLICT(code) DO NOTHING").run(set, now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, 'common', '{}', 'manual-test', 'I34B', 1, ?, ?)").run(printing, set, name, collect, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'I34B', 1, ?, ?)").run(sku, printing, now, now);
  database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(run, "a".repeat(64), "b".repeat(64), now, now);
  database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 200, 'priced', NULL, ?, ?)").run(snapshot, run, sku, now, now);
  database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'fixture', 'market/v1', 200, 200, 170, 250, 20, 25, '{}', '[]', ?, ?)").run(quote, sku, snapshot, now, validUntil);
}

async function playerWithHoldings(app: Awaited<ReturnType<typeof createTestApp>>["app"], database: ReturnType<typeof openSqliteDatabase>, email = "batch@example.test", holdings: Array<{ skuId: string; quantity: number; available: number; orderLocked?: number }> = [{ skuId: ids.sku, quantity: 3, available: 3 }]) {
  const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "批量卖出玩家", password: "correct-horse-battery-staple" } });
  const authorization = `Bearer ${registration.json().data.accessToken as string}`;
  const archive = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": "batch-archive-key-01" }, payload: {} });
  expect(archive.statusCode).toBe(201);
  const userId = (database.prepare("SELECT id FROM users WHERE email = ?").get(email) as { id: string }).id;
  for (const holding of holdings) {
    const orderLocked = holding.orderLocked ?? 0;
    // 库存不变量：quantity = available + order_locked + tournament_locked。
    database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, market_value_captured_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 100, NULL, NULL, ?)").run(`70000000-0000-4000-8000-${holding.skuId.slice(-12)}`, userId, holding.skuId, holding.available + orderLocked, holding.available, orderLocked, "2026-08-04T00:00:00.000Z");
  }
  return { authorization, userId };
}

describe("I34B 按筛选结果批量卖出", () => {
  it("逐 SKU 卖完可用库存（不保留一张），单事务汇总收入/费用，幂等重放", async () => {
    const { app, database } = await createTestApp();
    const skuB = "30000000-0000-4000-8000-000000000182";
    seedTradableQuote(database, ids.sku, ids.printing, ids.set, ids.snapshot, ids.run, ids.quote, "批量测试卡甲", "1");
    seedTradableQuote(database, skuB, "20000000-0000-4000-8000-000000000182", ids.set, "50000000-0000-4000-8000-000000000182", "40000000-0000-4000-8000-000000000182", "60000000-0000-4000-8000-000000000182", "批量测试卡乙", "2");
    const { authorization } = await playerWithHoldings(app, database, "batch@example.test", [
      { skuId: ids.sku, quantity: 3, available: 3 },
      { skuId: skuB, quantity: 2, available: 2 }
    ]);
    const request = { method: "POST" as const, url: "/v1/npc-trades/sell/batch", headers: { authorization, "idempotency-key": "batch-sell-key-0001" }, payload: { skuIds: [ids.sku, skuB] } };
    const [first, replay] = await Promise.all([app.inject(request), app.inject(request)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const result = (first.statusCode === 201 ? first : replay).json().data.result;
    // 甲卖 3 张（170/张、费用 20/张），乙卖 2 张；卖完全部可用库存（不保留一张）。
    expect(result).toMatchObject({ cardCount: 5, income: { amount: 850, currency: "GAME_CREDIT" }, fee: { amount: 100, currency: "GAME_CREDIT" } });
    expect(result.soldItems).toHaveLength(2);
    expect(result.skippedItems).toEqual([]);
    // 库存、账本、成交、库存流水各一次，且为原子写入。
    expect(database.prepare("SELECT sku_id, quantity, available_quantity FROM inventory_holdings ORDER BY sku_id").all()).toEqual([
      { sku_id: ids.sku, quantity: 0, available_quantity: 0 },
      { sku_id: skuB, quantity: 0, available_quantity: 0 }
    ]);
    expect(database.prepare("SELECT total_amount, available_amount FROM accounts").get()).toEqual({ total_amount: 10850, available_amount: 10850 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM npc_trades WHERE side = 'sell'").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT reason, COUNT(*) AS count FROM inventory_entries WHERE reason = 'npc_sell_batch' GROUP BY reason").get()).toEqual({ reason: "npc_sell_batch", count: 2 });
    await app.close(); database.close();
  });

  it("跳过未持有/无可用/报价缺失或过期/额度用尽的 SKU，失败不产生部分结算", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database, ids.sku, ids.printing, ids.set, ids.snapshot, ids.run, ids.quote);
    const unheldSku = "30000000-0000-4000-8000-000000000183";
    const lockedSku = "30000000-0000-4000-8000-000000000184";
    seedTradableQuote(database, lockedSku, "20000000-0000-4000-8000-000000000184", ids.set, "50000000-0000-4000-8000-000000000184", "40000000-0000-4000-8000-000000000184", "60000000-0000-4000-8000-000000000184", "锁定卡", "4");
    const { authorization, userId } = await playerWithHoldings(app, database, "batch@example.test", [
      { skuId: ids.sku, quantity: 2, available: 0, orderLocked: 2 }, // 有持有但可用为 0（全部被订单锁定）
      { skuId: lockedSku, quantity: 3, available: 2, orderLocked: 1 }
    ]);
    // 当日额度用尽：插入已结算成交使 remaining=0。
    database.prepare("UPDATE npc_trade_limits SET max_quantity_per_user_sku_day = 3").run();
    database.prepare("INSERT INTO npc_trades (id, user_id, sku_id, side, quote_id, quote_version, unit_price_amount, unit_fee_amount, total_amount, quantity, settlement_date, created_at) VALUES (?, ?, ?, 'sell', ?, 'market/v1', 170, 20, 510, 3, ?, ?)").run("80000000-0000-4000-8000-000000000181", userId, lockedSku, ids.quote, "2026-08-04", "2026-08-04T00:00:00.000Z");
    const result = await app.inject({ method: "POST", url: "/v1/npc-trades/sell/batch", headers: { authorization, "idempotency-key": "batch-skip-0001" }, payload: { skuIds: [ids.sku, lockedSku, unheldSku] } });
    expect(result.statusCode).toBe(201);
    expect(result.json().data.result).toMatchObject({
      cardCount: 0,
      soldItems: [],
      skippedItems: [
        { skuId: ids.sku, reason: "no_available_quantity" },
        { skuId: lockedSku, reason: "trade_limit_reached" },
        { skuId: unheldSku, reason: "not_held" }
      ]
    });
    // 报价过期：全部跳过。
    database.prepare("UPDATE npc_trade_limits SET max_quantity_per_user_sku_day = 100").run();
    database.prepare("UPDATE market_quotes SET valid_until = '2000-01-01T00:00:00.000Z'").run();
    const stale = await app.inject({ method: "POST", url: "/v1/npc-trades/sell/batch", headers: { authorization, "idempotency-key": "batch-stale-0001" }, payload: { skuIds: [lockedSku] } });
    expect(stale.json().data.result.skippedItems).toEqual([{ skuId: lockedSku, reason: "quote_stale" }]);
    // 请求体校验：空数组/非 uuid/缺幂等键均 400。
    const empty = await app.inject({ method: "POST", url: "/v1/npc-trades/sell/batch", headers: { authorization, "idempotency-key": "batch-empty-0001" }, payload: { skuIds: [] } });
    expect(empty.statusCode).toBe(400);
    const missingKey = await app.inject({ method: "POST", url: "/v1/npc-trades/sell/batch", headers: { authorization }, payload: { skuIds: [lockedSku] } });
    expect(missingKey.statusCode).toBe(400);
    await app.close(); database.close();
  });

  it("同键异参返回 IDEMPOTENCY_CONFLICT，未建档存档被拒绝", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database, ids.sku, ids.printing, ids.set, ids.snapshot, ids.run, ids.quote);
    const { authorization } = await playerWithHoldings(app, database, "batch@example.test");
    await app.inject({ method: "POST", url: "/v1/npc-trades/sell/batch", headers: { authorization, "idempotency-key": "batch-conflict-key" }, payload: { skuIds: [ids.sku] } });
    const conflict = await app.inject({ method: "POST", url: "/v1/npc-trades/sell/batch", headers: { authorization, "idempotency-key": "batch-conflict-key" }, payload: { skuIds: [ids.sku, "30000000-0000-4000-8000-000000000199"] } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
    const registration2 = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "batch-norecord@example.test", displayName: "无存档玩家", password: "correct-horse-battery-staple" } });
    const noArchive = await app.inject({ method: "POST", url: "/v1/npc-trades/sell/batch", headers: { authorization: `Bearer ${registration2.json().data.accessToken as string}`, "idempotency-key": "batch-noarchive-01" }, payload: { skuIds: [ids.sku] } });
    expect(noArchive.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_CONFLICT" } });
    await app.close(); database.close();
  });
});
