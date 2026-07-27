import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";

const directories: string[] = [];
const ids = {
  set: "10000000-0000-4000-8000-000000000161",
  printing: "20000000-0000-4000-8000-000000000161",
  sku: "30000000-0000-4000-8000-000000000161",
  run: "40000000-0000-4000-8000-000000000161",
  snapshot: "50000000-0000-4000-8000-000000000161",
  quote: "60000000-0000-4000-8000-000000000161"
};

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-orders-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

function seedTradableQuote(database: ReturnType<typeof openSqliteDatabase>, validUntil = "2099-01-01T00:00:00.000Z") {
  const now = "2026-07-27T00:00:00.000Z";
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'ORD', '订单测试系列', 'manual-test', ?)").run(ids.set, now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '订单测试卡', '1', NULL, 'rare', '{}', 'manual-test', 'fixture', 1, ?, ?)").run(ids.printing, ids.set, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'fixture', 1, ?, ?)").run(ids.sku, ids.printing, now, now);
  database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(ids.run, "a".repeat(64), "b".repeat(64), now, now);
  database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 200, 'priced', NULL, ?, ?)").run(ids.snapshot, ids.run, ids.sku, now, now);
  database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'fixture', 'market/v1', 200, 200, 170, 250, 20, 25, '{}', '[]', ?, ?)").run(ids.quote, ids.sku, ids.snapshot, now, validUntil);
}

async function player(app: Awaited<ReturnType<typeof createTestApp>>["app"], email: string, displayName: string) {
  const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName, password: "correct-horse-battery-staple" } });
  const authorization = `Bearer ${registration.json().data.accessToken as string}`;
  const archive = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": `archive-${Math.random().toString(36).slice(2)}-123456` }, payload: {} });
  expect(archive.statusCode).toBe(201);
  return authorization;
}

async function previewBuy(app: Awaited<ReturnType<typeof createTestApp>>["app"], authorization: string, quantity: number) {
  return (await app.inject({ method: "GET", url: `/v1/orders/buy/${ids.sku}/preview?quantity=${quantity}`, headers: { authorization } })).json();
}
async function previewSell(app: Awaited<ReturnType<typeof createTestApp>>["app"], authorization: string, quantity: number) {
  return (await app.inject({ method: "GET", url: `/v1/orders/sell/${ids.sku}/preview?quantity=${quantity}`, headers: { authorization } })).json();
}

function createBody(preview: { previewVersion: string }, limitPrice: number, quantity: number) {
  return { quoteId: ids.quote, quoteVersion: "market/v1", previewVersion: preview.previewVersion, quantity, limitPrice };
}

describe("I18B 双边委托预览", () => {
  it("买单预览返回服务端限价带、费用、预计支出、可用余额与预览版本", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `buy-${Math.random()}@example.test`, "买方");
    const preview = await previewBuy(app, authorization, 3);
    // 限价带：marketPrice 200 ± 5000bp → [100, 300]；order_fee_bps 200 → 单位 4、全量 12。
    expect(preview).toMatchObject({ ok: true, data: { preview: { skuId: ids.sku, side: "buy", quantity: 3, quoteId: ids.quote, quoteVersion: "market/v1", reservedFunds: { amount: 612 }, estimatedAmount: { amount: 600 }, limitBand: { marketPrice: { amount: 200 }, min: { amount: 100 }, max: { amount: 300 }, limitPriceBandBasisPoints: 5000 }, canPlace: true, unavailableReason: null } } });
    expect(preview.data.preview.fees).toEqual([{ kind: "order_fee", amount: { amount: 12, currency: "GAME_CREDIT" } }, { kind: "fulfillment_deposit", amount: { amount: 60, currency: "GAME_CREDIT" } }]);
    expect(preview.data.preview.previewVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(preview.data.preview.limit.maxQuantityPerOrder).toBe(20);
    await app.close(); database.close();
  });

  it("卖单预览返回可用库存、保证金预占与预计到手（order_fee 不预占）", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `sell-${Math.random()}@example.test`, "卖方");
    // 先用 NPC 买入取得 2 张可用库存。
    const buy = await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "seed-buy-0001" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 2, maxUnitPrice: 250 } });
    expect(buy.statusCode).toBe(201);
    const preview = await previewSell(app, authorization, 2);
    // fulfillment_deposit_bps 1000 → 单位 20、全量 40；卖单预占资金只含保证金 40。
    expect(preview).toMatchObject({ ok: true, data: { preview: { side: "sell", quantity: 2, availableQuantity: 2, reservedFunds: { amount: 40 }, estimatedAmount: { amount: 400 }, canPlace: true } } });
    await app.close(); database.close();
  });

  it("无报价或不可交易 SKU 返回 PRICE_UNAVAILABLE；过期报价返回 VERSION_STALE", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `preview-${Math.random()}@example.test`, "预览方");
    database.prepare("UPDATE card_skus SET tradable = 0").run();
    const untradable = await previewBuy(app, authorization, 1);
    expect(untradable).toMatchObject({ ok: false, error: { code: "PRICE_UNAVAILABLE" } });
    database.prepare("UPDATE card_skus SET tradable = 1").run();
    database.prepare("UPDATE market_quotes SET valid_until = '2000-01-01T00:00:00.000Z'").run();
    const stale = await previewBuy(app, authorization, 1);
    expect(stale).toMatchObject({ ok: false, error: { code: "VERSION_STALE" } });
    await app.close(); database.close();
  });
});

describe("I18B 买单创建与幂等", () => {
  it("以未过期预览版本原子预占买方资金并写委托、审计与幂等响应", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `create-${Math.random()}@example.test`, "买方");
    const preview = await previewBuy(app, authorization, 2);
    const body = createBody(preview.data.preview, 200, 2);
    const request = { method: "POST" as const, url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "buy-create-0001" }, payload: body };
    const [first, replay] = await Promise.all([app.inject(request), app.inject(request)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const settled = (first.statusCode === 201 ? first : replay).json().data;
    expect(settled).toMatchObject({ order: { side: "buy", status: "open", originalQuantity: 2, remainingQuantity: 2, limitPrice: { amount: 200 }, reservedFunds: { amount: 408 }, reservedInventoryQuantity: 0, fulfillmentDeposit: null } });
    // 买单资金预占：总额不变，可用减少 408（200*2 + 4*2），冻结增加 408。
    expect(database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts").get()).toEqual({ total_amount: 10000, available_amount: 9592, frozen_amount: 408 });
    expect(database.prepare("SELECT side, status, original_quantity, remaining_quantity, limit_price_amount, reserved_funds_amount FROM bilateral_orders").get()).toEqual({ side: "buy", status: "open", original_quantity: 2, remaining_quantity: 2, limit_price_amount: 200, reserved_funds_amount: 408 });
    expect(database.prepare("SELECT reason, amount, status FROM fund_holds WHERE entity_type = 'bilateral_order'").get()).toMatchObject({ reason: "order_buy", amount: 408, status: "active" });
    expect(database.prepare("SELECT action FROM audit_logs WHERE entity_type = 'bilateral_order'").get()).toEqual({ action: "bilateral_order.created" });
    await app.close(); database.close();
  });

  it("拒绝同键异参、余额不足、单笔/单日额度超限与限价越界", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `reject-${Math.random()}@example.test`, "买方");
    const preview = await previewBuy(app, authorization, 1);
    const body = createBody(preview.data.preview, 200, 1);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "reject-buy-0001" }, payload: body })).statusCode).toBe(201);
    // 同键异参 → IDEMPOTENCY_CONFLICT
    const conflict = await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "reject-buy-0001" }, payload: { ...body, limitPrice: 199 } });
    expect(conflict.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    // 余额不足
    database.prepare("UPDATE accounts SET total_amount = 100, available_amount = 100, frozen_amount = 0").run();
    const freshBalancePreview = await previewBuy(app, authorization, 1);
    const insufficient = await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "reject-buy-lowbal" }, payload: createBody(freshBalancePreview.data.preview, 200, 1) });
    expect(insufficient.json()).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_BALANCE" } });
    // 单笔额度
    database.prepare("UPDATE accounts SET total_amount = 1000000, available_amount = 1000000, frozen_amount = 0").run();
    database.prepare("UPDATE bilateral_order_limits SET max_quantity_per_order = 1, max_quantity_per_user_sku_day = 100").run();
    const overOrderPreview = await previewBuy(app, authorization, 2);
    const overOrder = await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "reject-buy-over01" }, payload: createBody(overOrderPreview.data.preview, 200, 2) });
    expect(overOrder.json()).toMatchObject({ ok: false, error: { code: "RULE_VIOLATION" } });
    // 单日额度
    database.prepare("UPDATE bilateral_order_limits SET max_quantity_per_order = 20, max_quantity_per_user_sku_day = 1").run();
    const overDayPreview = await previewBuy(app, authorization, 2);
    const overDay = await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "reject-buy-overday" }, payload: createBody(overDayPreview.data.preview, 200, 2) });
    expect(overDay.json()).toMatchObject({ ok: false, error: { code: "RULE_VIOLATION" } });
    // 限价越界（超出 300 上限）
    database.prepare("UPDATE bilateral_order_limits SET max_quantity_per_user_sku_day = 100").run();
    const inBandPreview = await previewBuy(app, authorization, 1);
    const outOfBand = await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "reject-buy-oob0001" }, payload: createBody(inBandPreview.data.preview, 301, 1) });
    expect(outOfBand.json()).toMatchObject({ ok: false, error: { code: "RULE_VIOLATION" } });
    await app.close(); database.close();
  });

  it("预览过期（报价过期）必须重新预览，否则 VERSION_STALE", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `stale-${Math.random()}@example.test`, "买方");
    const preview = await previewBuy(app, authorization, 1);
    // 报价在预览后过期：客户端仍回传旧 previewVersion，但服务端报价已不再有效。
    database.prepare("UPDATE market_quotes SET valid_until = '2000-01-01T00:00:00.000Z'").run();
    const stale = await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "stale-buy-0001" }, payload: createBody(preview.data.preview, 200, 1) });
    expect(stale.json()).toMatchObject({ ok: false, error: { code: "VERSION_STALE" } });
    await app.close(); database.close();
  });
});

describe("I18B 卖单创建与库存/保证金预占", () => {
  it("锁定卖方库存并预占保证金，order_fee 不预占", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `seller-${Math.random()}@example.test`, "卖方");
    const buy = await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "sell-seed-0001" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 2, maxUnitPrice: 250 } });
    expect(buy.statusCode).toBe(201);
    const preview = await previewSell(app, authorization, 2);
    const request = { method: "POST" as const, url: `/v1/orders/sell/${ids.sku}`, headers: { authorization, "idempotency-key": "sell-create-0001" }, payload: createBody(preview.data.preview, 200, 2) };
    const [first, replay] = await Promise.all([app.inject(request), app.inject(request)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const settled = (first.statusCode === 201 ? first : replay).json().data;
    expect(settled).toMatchObject({ order: { side: "sell", status: "open", remainingQuantity: 2, reservedFunds: { amount: 40 }, reservedInventoryQuantity: 2, fulfillmentDeposit: { amount: 40 } } });
    // 库存：可用 0、订单锁定 2；账户冻结保证金 40。
    expect(database.prepare("SELECT available_quantity, order_locked_quantity FROM inventory_holdings").get()).toEqual({ available_quantity: 0, order_locked_quantity: 2 });
    expect(database.prepare("SELECT frozen_amount FROM accounts").get()).toEqual({ frozen_amount: 40 });
    expect(database.prepare("SELECT reason, amount FROM fund_holds WHERE reason = 'order_fulfillment_deposit'").get()).toEqual({ reason: "order_fulfillment_deposit", amount: 40 });
    await app.close(); database.close();
  });

  it("拒绝可用库存不足与单日额度超限", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `sell-rej-${Math.random()}@example.test`, "卖方");
    // 库存不足：可用 0
    const preview = await previewSell(app, authorization, 1);
    expect(preview.data.preview.canPlace).toBe(false);
    expect(preview.data.preview.unavailableReason).toBe("insufficient_inventory");
    const insufficient = await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization, "idempotency-key": "sell-rej-inv0001" }, payload: createBody(preview.data.preview, 200, 1) });
    expect(insufficient.json()).toMatchObject({ ok: false, error: { code: "INSUFFICIENT_INVENTORY" } });
    await app.close(); database.close();
  });
});

describe("I18B 撤单幂等释放", () => {
  it("撤单释放买单资金预占，重放返回首次结果", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `cancel-${Math.random()}@example.test`, "买方");
    const preview = await previewBuy(app, authorization, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "cancel-buy-create" }, payload: createBody(preview.data.preview, 200, 2) })).statusCode).toBe(201);
    const orderId = (database.prepare("SELECT id FROM bilateral_orders").get() as { id: string }).id;
    const cancelRequest = { method: "POST" as const, url: `/v1/orders/${orderId}/cancel`, headers: { authorization, "idempotency-key": "cancel-buy-run01" }, payload: {} };
    const [first, replay] = await Promise.all([app.inject(cancelRequest), app.inject(cancelRequest)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 200]);
    expect(first.json()).toMatchObject({ ok: true, data: { order: { status: "cancelled", reservedFunds: { amount: 408 }, version: 2 } } });
    // 资金全部释放：可用恢复、冻结归零。
    expect(database.prepare("SELECT available_amount, frozen_amount FROM accounts").get()).toEqual({ available_amount: 10000, frozen_amount: 0 });
    expect(database.prepare("SELECT status FROM fund_holds WHERE entity_type = 'bilateral_order'").get()).toEqual({ status: "released" });
    await app.close(); database.close();
  });

  it("撤单释放卖单库存与保证金，且不可重复撤单", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `cancel-sell-${Math.random()}@example.test`, "卖方");
    expect((await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "cancel-sell-seed" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 2, maxUnitPrice: 250 } })).statusCode).toBe(201);
    const preview = await previewSell(app, authorization, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization, "idempotency-key": "cancel-sell-create" }, payload: createBody(preview.data.preview, 200, 2) })).statusCode).toBe(201);
    const orderId = (database.prepare("SELECT id FROM bilateral_orders").get() as { id: string }).id;
    expect((await app.inject({ method: "POST", url: `/v1/orders/${orderId}/cancel`, headers: { authorization, "idempotency-key": "cancel-sell-run01" }, payload: {} })).statusCode).toBe(200);
    expect(database.prepare("SELECT available_quantity, order_locked_quantity FROM inventory_holdings").get()).toEqual({ available_quantity: 2, order_locked_quantity: 0 });
    // 卖方此前以 250 单价买入 2 张（花费 500），撤单后保留卡片并退回保证金，可用余额恢复到 9500。
    expect(database.prepare("SELECT available_amount, frozen_amount FROM accounts").get()).toEqual({ available_amount: 9500, frozen_amount: 0 });
    // 已撤订单再次撤单（不同幂等键）→ RESOURCE_CONFLICT
    const again = await app.inject({ method: "POST", url: `/v1/orders/${orderId}/cancel`, headers: { authorization, "idempotency-key": "cancel-sell-again" }, payload: {} });
    expect(again.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_CONFLICT" } });
    await app.close(); database.close();
  });
});

describe("I18B 双边订单簿与我的委托查询", () => {
  it("订单簿按买跌卖涨聚合剩余量，我的委托分页只返回自己", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const buyAuth = await player(app, `book-buy-${Math.random()}@example.test`, "买方A");
    const sellAuth = await player(app, `book-sell-${Math.random()}@example.test`, "卖方A");
    expect((await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization: sellAuth, "idempotency-key": "book-sell-seed" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 2, maxUnitPrice: 250 } })).statusCode).toBe(201);
    const buyPreview = await previewBuy(app, buyAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyAuth, "idempotency-key": "book-buy-create" }, payload: createBody(buyPreview.data.preview, 210, 2) })).statusCode).toBe(201);
    const sellPreview = await previewSell(app, sellAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization: sellAuth, "idempotency-key": "book-sell-create" }, payload: createBody(sellPreview.data.preview, 220, 2) })).statusCode).toBe(201);

    const book = (await app.inject({ method: "GET", url: `/v1/orders/book/${ids.sku}`, headers: { authorization: buyAuth } })).json().data.book;
    expect(book).toMatchObject({ skuId: ids.sku, bids: [{ limitPrice: { amount: 210 }, remainingQuantity: 2, orderCount: 1 }], asks: [{ limitPrice: { amount: 220 }, remainingQuantity: 2, orderCount: 1 }] });

    const mine = (await app.inject({ method: "GET", url: "/v1/orders", headers: { authorization: buyAuth } })).json().data;
    expect(mine.items).toHaveLength(1);
    expect(mine.items[0]).toMatchObject({ side: "buy", limitPrice: { amount: 210 } });

    const notFound = await app.inject({ method: "GET", url: `/v1/orders/${mine.items[0].id}`, headers: { authorization: sellAuth } });
    expect(notFound.statusCode).toBe(404);
    await app.close(); database.close();
  });
});

describe("I18B 事务回滚", () => {
  it("库存写入异常时回滚卖单的库存锁定、保证金预占与幂等占位", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `rollback-${Math.random()}@example.test`, "卖方");
    expect((await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "rollback-seed" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 2, maxUnitPrice: 250 } })).statusCode).toBe(201);
    database.exec("CREATE TRIGGER fail_order_lock BEFORE UPDATE ON inventory_holdings WHEN NEW.order_locked_quantity > OLD.order_locked_quantity BEGIN SELECT RAISE(ABORT, 'forced lock failure'); END");
    const preview = await previewSell(app, authorization, 1);
    const failed = await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization, "idempotency-key": "rollback-sell-0001" }, payload: createBody(preview.data.preview, 200, 1) });
    expect(failed.statusCode).toBe(500);
    expect(database.prepare("SELECT available_quantity, order_locked_quantity FROM inventory_holdings").get()).toEqual({ available_quantity: 2, order_locked_quantity: 0 });
    expect(database.prepare("SELECT frozen_amount FROM accounts").get()).toEqual({ frozen_amount: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM bilateral_orders").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_requests WHERE idempotency_key = 'rollback-sell-0001'").get()).toEqual({ count: 0 });
    await app.close(); database.close();
  });
});
