import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";

const directories: string[] = [];
const ids = {
  set: "10000000-0000-4000-8000-000000000151",
  printing: "20000000-0000-4000-8000-000000000151",
  sku: "30000000-0000-4000-8000-000000000151",
  run: "40000000-0000-4000-8000-000000000151",
  snapshot: "50000000-0000-4000-8000-000000000151",
  quote: "60000000-0000-4000-8000-000000000151"
};

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-npc-trade-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

function seedTradableQuote(database: ReturnType<typeof openSqliteDatabase>, validUntil = "2099-01-01T00:00:00.000Z") {
  const now = "2026-07-27T00:00:00.000Z";
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'NPC', 'NPC 测试系列', 'manual-test', ?)").run(ids.set, now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'NPC 测试卡', '1', NULL, 'rare', '{}', 'manual-test', 'fixture', 1, ?, ?)").run(ids.printing, ids.set, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'fixture', 1, ?, ?)").run(ids.sku, ids.printing, now, now);
  database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(ids.run, "a".repeat(64), "b".repeat(64), now, now);
  database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 200, 'priced', NULL, ?, ?)").run(ids.snapshot, ids.run, ids.sku, now, now);
  database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'fixture', 'market/v1', 200, 200, 170, 250, 20, 25, '{}', '[]', ?, ?)").run(ids.quote, ids.sku, ids.snapshot, now, validUntil);
}

async function player(app: Awaited<ReturnType<typeof createTestApp>>["app"]) {
  const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: `npc-${Math.random()}@example.test`, displayName: "NPC 买家", password: "correct-horse-battery-staple" } });
  const authorization = `Bearer ${registration.json().data.accessToken as string}`;
  const archive = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": `archive-${Math.random().toString(36).slice(2)}-123456` }, payload: {} });
  expect(archive.statusCode).toBe(201);
  return authorization;
}

function buyRequest(authorization: string, body: Record<string, unknown> = {}) {
  return { method: "POST" as const, url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "npc-buy-key-0001" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 2, maxUnitPrice: 250, ...body } };
}

function sellRequest(authorization: string, body: Record<string, unknown> = {}) {
  return { method: "POST" as const, url: `/v1/npc-trades/sell/${ids.sku}`, headers: { authorization, "idempotency-key": "npc-sell-key-0001" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 2, minUnitPrice: 170, ...body } };
}

describe("I15B NPC 买入", () => {
  it("预览并以不可变报价、限价和幂等键原子结算余额、库存、成交、账本和事实事件", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app);
    const preview = await app.inject({ method: "GET", url: `/v1/npc-trades/buy/${ids.sku}/preview?quantity=2`, headers: { authorization } });
    expect(preview.json()).toMatchObject({ ok: true, data: { preview: { quoteId: ids.quote, quoteVersion: "market/v1", unitPrice: { amount: 250 }, unitFee: { amount: 25 }, total: { amount: 500 }, fee: { amount: 50 }, canPurchase: true } } });
    const request = buyRequest(authorization);
    const [first, replay] = await Promise.all([app.inject(request), app.inject(request)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const settled = (first.statusCode === 201 ? first : replay).json().data;
    expect(settled).toMatchObject({ trade: { skuId: ids.sku, quoteId: ids.quote, quantity: 2, total: { amount: 500 }, fee: { amount: 50 } }, balance: { total: { amount: 9500 }, available: { amount: 9500 } }, holding: { skuId: ids.sku, quantity: 2, averageCost: { amount: 250 } } });
    expect(database.prepare("SELECT quote_id, quote_version, unit_price_amount, unit_fee_amount, total_amount, quantity FROM npc_trades").get()).toEqual({ quote_id: ids.quote, quote_version: "market/v1", unit_price_amount: 250, unit_fee_amount: 25, total_amount: 500, quantity: 2 });
    expect(database.prepare("SELECT reason, amount FROM ledger_entries WHERE reason = 'npc_buy'").get()).toEqual({ reason: "npc_buy", amount: 500 });
    expect(database.prepare("SELECT reason, quantity_delta FROM inventory_entries WHERE reason = 'npc_buy'").get()).toEqual({ reason: "npc_buy", quantity_delta: 2 });
    expect(database.prepare("SELECT event_type, payload_json FROM fact_events WHERE event_type = 'npc.trade.settled'").get()).toMatchObject({ event_type: "npc.trade.settled", payload_json: expect.stringContaining(ids.sku) });
    expect(database.prepare("SELECT COUNT(*) AS count FROM outbox WHERE destination = 'market.fact-event'").get()).toEqual({ count: 1 });
    await app.close(); database.close();
  });

  it("拒绝同键异参、过期报价、余额不足和超出单笔/单日交易额度", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app);
    const settled = await app.inject(buyRequest(authorization));
    expect(settled.statusCode).toBe(201);
    const conflict = await app.inject(buyRequest(authorization, { maxUnitPrice: 249 }));
    expect(conflict.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    database.prepare("UPDATE accounts SET total_amount = 100, available_amount = 100").run();
    const insufficient = await app.inject({ ...buyRequest(authorization, { quantity: 1 }), headers: { authorization, "idempotency-key": "npc-buy-low-balance" } });
    expect(insufficient.json()).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_BALANCE" } });
    database.prepare("UPDATE accounts SET total_amount = 10000, available_amount = 10000").run();
    database.prepare("UPDATE npc_trade_limits SET max_quantity_per_trade = 1, max_quantity_per_user_sku_day = 2").run();
    const overOrder = await app.inject({ ...buyRequest(authorization), headers: { authorization, "idempotency-key": "npc-buy-over-order" } });
    expect(overOrder.json()).toMatchObject({ ok: false, error: { code: "RULE_VIOLATION" } });
    database.prepare("UPDATE npc_trade_limits SET max_quantity_per_trade = 20, max_quantity_per_user_sku_day = 2").run();
    const overDay = await app.inject({ ...buyRequest(authorization, { quantity: 1 }), headers: { authorization, "idempotency-key": "npc-buy-over-day01" } });
    expect(overDay.json()).toMatchObject({ ok: false, error: { code: "RULE_VIOLATION" } });
    database.prepare("UPDATE market_quotes SET valid_until = '2000-01-01T00:00:00.000Z'").run();
    const stale = await app.inject({ ...buyRequest(authorization, { quantity: 1 }), headers: { authorization, "idempotency-key": "npc-buy-stale-0001" } });
    expect(stale.json()).toMatchObject({ ok: false, error: { code: "VERSION_STALE" } });
    await app.close(); database.close();
  });

  it("库存写入异常时回滚扣款、成交、事件和幂等占位", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app);
    database.exec("CREATE TRIGGER fail_npc_inventory BEFORE INSERT ON inventory_entries WHEN NEW.reason = 'npc_buy' BEGIN SELECT RAISE(ABORT, 'forced inventory failure'); END");
    const failed = await app.inject(buyRequest(authorization));
    expect(failed.statusCode).toBe(500);
    expect(database.prepare("SELECT total_amount, available_amount FROM accounts").get()).toEqual({ total_amount: 10000, available_amount: 10000 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM npc_trades").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fact_events WHERE event_type = 'npc.trade.settled'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_requests WHERE idempotency_key = 'npc-buy-key-0001'").get()).toEqual({ count: 0 });
    await app.close(); database.close();
  });
});

describe("I16B NPC 卖出", () => {
  it("按服务端收购价原子结算指定数量与全部可用库存，且锁定量不参与出售", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app);
    expect((await app.inject(buyRequest(authorization))).statusCode).toBe(201);

    const allPreview = await app.inject({ method: "GET", url: `/v1/npc-trades/sell/${ids.sku}/preview?quantity=all`, headers: { authorization } });
    expect(allPreview.json()).toMatchObject({ ok: true, data: { preview: { quantity: 2, availableQuantity: 2, unitPrice: { amount: 170 }, unitFee: { amount: 20 }, total: { amount: 340 }, fee: { amount: 40 }, canSell: true } } });
    const [first, replay] = await Promise.all([app.inject(sellRequest(authorization)), app.inject(sellRequest(authorization))]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    expect((first.statusCode === 201 ? first : replay).json()).toMatchObject({ ok: true, data: { trade: { side: "sell", quantity: 2, unitPrice: { amount: 170 }, total: { amount: 340 } }, balance: { total: { amount: 9840 } }, holding: { quantity: 0, availableQuantity: 0, averageCost: { amount: 0 } } } });
    expect(database.prepare("SELECT reason, direction, amount FROM ledger_entries WHERE reason = 'npc_sell'").get()).toEqual({ reason: "npc_sell", direction: "credit", amount: 340 });
    expect(database.prepare("SELECT reason, quantity_delta FROM inventory_entries WHERE reason = 'npc_sell'").get()).toEqual({ reason: "npc_sell", quantity_delta: -2 });
    expect(database.prepare("SELECT side, unit_price_amount, total_amount FROM npc_trades WHERE side = 'sell'").get()).toEqual({ side: "sell", unit_price_amount: 170, total_amount: 340 });
    expect(database.prepare("SELECT payload_json FROM fact_events WHERE event_type = 'npc.trade.settled' ORDER BY rowid DESC LIMIT 1").get()).toMatchObject({ payload_json: expect.stringContaining('"side":"sell"') });
    await app.close(); database.close();
  });

  it("拒绝同键异参、被锁定或不足的库存、低于最低价的报价与超额出售", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app);
    expect((await app.inject(buyRequest(authorization))).statusCode).toBe(201);
    const sold = await app.inject(sellRequest(authorization, { quantity: 1 }));
    expect(sold.statusCode).toBe(201);
    const conflict = await app.inject(sellRequest(authorization, { quantity: 2 }));
    expect(conflict.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    database.prepare("UPDATE inventory_holdings SET available_quantity = 0, order_locked_quantity = 1").run();
    const locked = await app.inject({ ...sellRequest(authorization, { quantity: 1 }), headers: { authorization, "idempotency-key": "npc-sell-locked-0001" } });
    expect(locked.json()).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_INVENTORY" } });
    database.prepare("UPDATE inventory_holdings SET available_quantity = 1, order_locked_quantity = 0").run();
    database.prepare("UPDATE market_quotes SET npc_buy_price_amount = 160").run();
    const belowLimit = await app.inject({ ...sellRequest(authorization, { quantity: 1 }), headers: { authorization, "idempotency-key": "npc-sell-price-0001" } });
    expect(belowLimit.json()).toMatchObject({ ok: false, error: { code: "VERSION_STALE" } });
    database.prepare("UPDATE market_quotes SET npc_buy_price_amount = 170").run();
    database.prepare("UPDATE npc_trade_limits SET max_quantity_per_trade = 1, max_quantity_per_user_sku_day = 1").run();
    const overLimit = await app.inject({ ...sellRequest(authorization, { quantity: 1 }), headers: { authorization, "idempotency-key": "npc-sell-limit-0001" } });
    expect(overLimit.json()).toMatchObject({ ok: false, error: { code: "RULE_VIOLATION" } });
    await app.close(); database.close();
  });

  it("库存流水异常时回滚库存、收入、成交、事件和幂等占位", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app);
    expect((await app.inject(buyRequest(authorization))).statusCode).toBe(201);
    database.exec("CREATE TRIGGER fail_npc_sell_inventory BEFORE INSERT ON inventory_entries WHEN NEW.reason = 'npc_sell' BEGIN SELECT RAISE(ABORT, 'forced sell inventory failure'); END");
    const failed = await app.inject(sellRequest(authorization));
    expect(failed.statusCode).toBe(500);
    expect(database.prepare("SELECT total_amount, available_amount FROM accounts").get()).toEqual({ total_amount: 9500, available_amount: 9500 });
    expect(database.prepare("SELECT quantity, available_quantity FROM inventory_holdings").get()).toEqual({ quantity: 2, available_quantity: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM npc_trades WHERE side = 'sell'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_requests WHERE idempotency_key = 'npc-sell-key-0001'").get()).toEqual({ count: 0 });
    await app.close(); database.close();
  });
});
