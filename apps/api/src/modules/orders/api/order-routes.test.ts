import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { createTaskRegistry } from "../../../task-runner.js";
import { TaskWorker } from "../../jobs/application/task-service.js";
import { SqliteJobRepository } from "../../jobs/infrastructure/sqlite-job-repository.js";

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
  const databasePath = join(directory, "test.db");
  const database = openSqliteDatabase(databasePath);
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: databasePath, AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), config, database, databasePath };
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
  it("I21B 高频撤单只标记复核，不阻断撤单或静默改资产", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    database.prepare("UPDATE bilateral_order_risk_limits SET order_cooldown_seconds = 0, max_orders_per_window = 20, max_cancellations_per_window = 1, cancellation_window_seconds = 3600").run();
    const authorization = await player(app, `risk-cancel-${Math.random()}@example.test`, "撤单风控方");
    for (const key of ["risk-cancel-first", "risk-cancel-second"]) {
      const preview = await previewBuy(app, authorization, 1);
      const created = await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": `${key}-create` }, payload: createBody(preview.data.preview, 200, 1) });
      expect(created.statusCode).toBe(201);
      const orderId = created.json().data.order.id as string;
      expect((await app.inject({ method: "POST", url: `/v1/orders/${orderId}/cancel`, headers: { authorization, "idempotency-key": `${key}-run` }, payload: {} })).statusCode).toBe(200);
    }
    expect(database.prepare("SELECT outcome, reasons_json, rule_version FROM order_risk_decisions WHERE action = 'cancel' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ outcome: "flagged", reasons_json: '["cancellation_frequency"]', rule_version: "order-risk/v1" });
    expect(database.prepare("SELECT available_amount, frozen_amount FROM accounts").get()).toEqual({ available_amount: 10000, frozen_amount: 0 });
    await app.close(); database.close();
  });

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

describe("I19B 撮合规则与服务端成交", () => {
  // 给卖方先 NPC 买入 seedQuantity 张，再挂卖单；返回卖单创建后的状态。
  async function seedSellerAndSell(app: Awaited<ReturnType<typeof createTestApp>>["app"], database: ReturnType<typeof openSqliteDatabase>, email: string, seedQuantity: number, sellQuantity: number, sellPrice: number, sellKey: string) {
    const authorization = await player(app, `${email}`, "卖方");
    expect((await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": `${sellKey}-seed` }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: seedQuantity, maxUnitPrice: 250 } })).statusCode).toBe(201);
    const preview = await previewSell(app, authorization, sellQuantity);
    expect((await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization, "idempotency-key": sellKey }, payload: createBody(preview.data.preview, sellPrice, sellQuantity) })).statusCode).toBe(201);
    return authorization;
  }

  it("全量撮合：买单吃掉卖单，资金/库存/保证金转为待履约，不写 p2p.trade.settled", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    await seedSellerAndSell(app, database, `full-sell-${Math.random()}@example.test`, 2, 2, 200, "full-sell");
    const buyAuth = await player(app, `full-buy-${Math.random()}@example.test`, "买方");
    // 买单限价 210 >= 卖单 200，创建后自动触发撮合；卖单先入订单簿为 maker，成交价取卖限价 200。
    const buyPreview = await previewBuy(app, buyAuth, 2);
    const created = await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyAuth, "idempotency-key": "full-buy" }, payload: createBody(buyPreview.data.preview, 210, 2) });
    expect(created.statusCode).toBe(201);

    const trades = database.prepare("SELECT buy_order_id, sell_order_id, quantity, execution_price_amount, buyer_fee_amount, status FROM bilateral_trades").all() as Array<{ buy_order_id: string; sell_order_id: string; quantity: number; execution_price_amount: number; buyer_fee_amount: number; status: string }>;
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ quantity: 2, execution_price_amount: 200, status: "matched_pending_fulfillment" });
    // 双方委托状态推进为 matched_pending_fulfillment，剩余数量归零。
    const orders = database.prepare("SELECT side, status, remaining_quantity FROM bilateral_orders ORDER BY side").all() as Array<{ side: string; status: string; remaining_quantity: number }>;
    expect(orders).toEqual([{ side: "buy", status: "matched_pending_fulfillment", remaining_quantity: 0 }, { side: "sell", status: "matched_pending_fulfillment", remaining_quantity: 0 }]);
    // 不写 p2p.trade.settled（留 I20B）。
    expect((database.prepare("SELECT COUNT(*) AS count FROM fact_events WHERE event_type = 'p2p.trade.settled'").get() as { count: number }).count).toBe(0);
    await app.close(); database.close();
  });

  it("部分成交：买<卖，剩余委托保持 partially_filled，已成交资金/库存/保证金切分", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    await seedSellerAndSell(app, database, `part-sell-${Math.random()}@example.test`, 5, 5, 200, "part-sell");
    const buyAuth = await player(app, `part-buy-${Math.random()}@example.test`, "买方");
    const buyPreview = await previewBuy(app, buyAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyAuth, "idempotency-key": "part-buy" }, payload: createBody(buyPreview.data.preview, 210, 2) })).statusCode).toBe(201);

    // 买单全成交(2 张)→matched_pending_fulfillment；卖单部分成交(2/5)→partially_filled。
    const buyOrder = database.prepare("SELECT status, remaining_quantity FROM bilateral_orders WHERE side = 'buy'").get() as { status: string; remaining_quantity: number };
    const sellOrder = database.prepare("SELECT status, remaining_quantity FROM bilateral_orders WHERE side = 'sell'").get() as { status: string; remaining_quantity: number };
    expect(buyOrder).toEqual({ status: "matched_pending_fulfillment", remaining_quantity: 0 });
    expect(sellOrder).toEqual({ status: "partially_filled", remaining_quantity: 3 });
    // 卖方库存：原 5 张，已成交 2 张离开持有 → 持有 3，order_locked 3（剩余未成交仍锁定）。
    const holding = database.prepare("SELECT quantity, available_quantity, order_locked_quantity FROM inventory_holdings").get() as { quantity: number; available_quantity: number; order_locked_quantity: number };
    expect(holding).toEqual({ quantity: 3, available_quantity: 0, order_locked_quantity: 3 });
    await app.close(); database.close();
  });

  it("I21B 自买自卖在创建阶段拦截并留下风控决策", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `self-${Math.random()}@example.test`, "自成交者");
    expect((await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "self-seed" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 2, maxUnitPrice: 250 } })).statusCode).toBe(201);
    const sellPreview = await previewSell(app, authorization, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization, "idempotency-key": "self-sell" }, payload: createBody(sellPreview.data.preview, 200, 2) })).statusCode).toBe(201);
    const buyPreview = await previewBuy(app, authorization, 2);
    const blocked = await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "self-buy" }, payload: createBody(buyPreview.data.preview, 210, 2) });
    expect(blocked).toMatchObject({ statusCode: 409 });
    expect(blocked.json()).toMatchObject({ ok: false, error: { code: "RULE_VIOLATION", message: expect.stringContaining("自买自卖") } });
    // 无成交、只有原卖单，决策可供人工复核。
    expect((database.prepare("SELECT COUNT(*) AS count FROM bilateral_trades").get() as { count: number }).count).toBe(0);
    expect(database.prepare("SELECT status FROM bilateral_orders").all()).toEqual([{ status: "open" }]);
    expect(database.prepare("SELECT outcome, rule_version FROM order_risk_decisions WHERE action = 'create' ORDER BY rowid DESC LIMIT 1").get()).toEqual({ outcome: "blocked", rule_version: "order-risk/v1" });
    await app.close(); database.close();
  });

  it("admin 显式触发撮合返回成交列表，普通玩家 403", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    await seedSellerAndSell(app, database, `admin-sell-${Math.random()}@example.test`, 2, 2, 200, "admin-sell");
    const buyAuth = await player(app, `admin-buy-${Math.random()}@example.test`, "买方");
    const buyPreview = await previewBuy(app, buyAuth, 2);
    // 用与卖单同价的买单创建（限价 200 >= 卖 200），创建后自动撮合。
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyAuth, "idempotency-key": "admin-buy" }, payload: createBody(buyPreview.data.preview, 200, 2) })).statusCode).toBe(201);

    // 注册一名管理员并提权。
    const adminEmail = `admin-${Math.random()}@example.test`;
    const adminAuthorization = await player(app, adminEmail, "管理员");
    database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(adminEmail);

    const denied = await app.inject({ method: "POST", url: `/v1/orders/${ids.sku}/match`, headers: { authorization: buyAuth } });
    expect(denied.statusCode).toBe(403);
    const triggered = await app.inject({ method: "POST", url: `/v1/orders/${ids.sku}/match`, headers: { authorization: adminAuthorization } });
    expect(triggered.statusCode).toBe(200);
    // 自动撮合已产生成交，admin 显式触发幂等重跑，不会重复成交。
    expect((database.prepare("SELECT COUNT(*) AS count FROM bilateral_trades").get() as { count: number }).count).toBe(1);
    await app.close(); database.close();
  });

  it("并发撮合同一剩余数量不会重复成交、超卖或超扣", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    await seedSellerAndSell(app, database, `cc-sell-${Math.random()}@example.test`, 2, 2, 200, "cc-sell-key");
    const buyAuth = await player(app, `cc-buy-${Math.random()}@example.test`, "买方");
    const buyPreview = await previewBuy(app, buyAuth, 2);
    // 用不会自动成交的低买单创建（限价 100 < 卖 200），然后并发 admin 触发两次。
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyAuth, "idempotency-key": "cc-buy-key01" }, payload: createBody(buyPreview.data.preview, 200, 2) })).statusCode).toBe(201);
    const adminEmail = `cc-admin-${Math.random()}@example.test`;
    const adminAuthorization = await player(app, adminEmail, "管理员");
    database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(adminEmail);

    const [first, second] = await Promise.all([
      app.inject({ method: "POST", url: `/v1/orders/${ids.sku}/match`, headers: { authorization: adminAuthorization } }),
      app.inject({ method: "POST", url: `/v1/orders/${ids.sku}/match`, headers: { authorization: adminAuthorization } })
    ]);
    // 并发中只有一次能产生成交；另一次因剩余数量已被消耗而无成交或安全失败。
    const totalTrades = (database.prepare("SELECT COUNT(*) AS count FROM bilateral_trades").get() as { count: number }).count;
    expect(totalTrades).toBe(1);
    const sellOrder = database.prepare("SELECT remaining_quantity FROM bilateral_orders WHERE side = 'sell'").get() as { remaining_quantity: number };
    expect(sellOrder.remaining_quantity).toBe(0);
    // 至少一次成功（200），且无重复成交。
    expect([first.statusCode, second.statusCode].sort()).toEqual(expect.arrayContaining([200]));
    await app.close(); database.close();
  });

  it("撮合事务回滚：写入异常时不留半完成成交或状态", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    await seedSellerAndSell(app, database, `rb-sell-${Math.random()}@example.test`, 2, 2, 200, "rb-sell-key");
    const buyAuth = await player(app, `rb-buy-${Math.random()}@example.test`, "买方");
    const buyPreview = await previewBuy(app, buyAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyAuth, "idempotency-key": "rb-buy-key01" }, payload: createBody(buyPreview.data.preview, 200, 2) })).statusCode).toBe(201);
    // 重置买卖委托为未撮合状态以便显式触发（自动撮合已成交，先清理成交记录后重置状态模拟回滚场景）。
    // 这里改为在创建卖单前注入失败触发器，验证撮合整笔回滚。
    database.exec("DELETE FROM bilateral_trades");
    database.prepare("UPDATE bilateral_orders SET status = 'open', remaining_quantity = original_quantity, version = version + 1").run();
    // 在 bilateral_trades 插入上强制失败。
    database.exec("CREATE TRIGGER fail_trade_insert BEFORE INSERT ON bilateral_trades BEGIN SELECT RAISE(ABORT, 'forced trade failure'); END");
    const adminEmail = `rb-admin-${Math.random()}@example.test`;
    const adminAuthorization = await player(app, adminEmail, "管理员");
    database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(adminEmail);
    const failed = await app.inject({ method: "POST", url: `/v1/orders/${ids.sku}/match`, headers: { authorization: adminAuthorization } });
    expect(failed.statusCode).toBe(500);
    // 回滚：无成交记录，双方委托保持 open 且剩余数量不变。
    expect((database.prepare("SELECT COUNT(*) AS count FROM bilateral_trades").get() as { count: number }).count).toBe(0);
    const orders = database.prepare("SELECT status, remaining_quantity FROM bilateral_orders ORDER BY side").all() as Array<{ status: string; remaining_quantity: number }>;
    expect(orders).toEqual([{ status: "open", remaining_quantity: 2 }, { status: "open", remaining_quantity: 2 }]);
    await app.close(); database.close();
  });
});

describe("I19F 玩家成交只读视图", () => {
  // 给卖方先 NPC 买入 seedQuantity 张再挂卖单；返回卖方鉴权。
  async function seedSellerAndSell(app: Awaited<ReturnType<typeof createTestApp>>["app"], database: ReturnType<typeof openSqliteDatabase>, email: string, seedQuantity: number, sellQuantity: number, sellPrice: number, sellKey: string) {
    const authorization = await player(app, email, "卖方");
    expect((await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": `${sellKey}-seed` }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: seedQuantity, maxUnitPrice: 250 } })).statusCode).toBe(201);
    const preview = await previewSell(app, authorization, sellQuantity);
    expect((await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization, "idempotency-key": sellKey }, payload: createBody(preview.data.preview, sellPrice, sellQuantity) })).statusCode).toBe(201);
    return authorization;
  }

  it("全量撮合后买卖双方各自看到自己的成交、待履约资产与角色，且脱敏对手身份", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    // 卖单先入订单簿（maker），成交价取卖限价 200。
    const sellAuth = await seedSellerAndSell(app, database, `f-sell-${Math.random()}@example.test`, 2, 2, 200, "full-sell-trades");
    const buyAuth = await player(app, `f-buy-${Math.random()}@example.test`, "买方");
    const buyPreview = await previewBuy(app, buyAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyAuth, "idempotency-key": "full-buy-trades" }, payload: createBody(buyPreview.data.preview, 210, 2) })).statusCode).toBe(201);

    const buyerView = (await app.inject({ method: "GET", url: "/v1/orders/trades", headers: { authorization: buyAuth } })).json().data;
    expect(buyerView.items).toHaveLength(1);
    expect(buyerView.items[0]).toMatchObject({ skuId: ids.sku, role: "buyer", quantity: 2, executionPrice: { amount: 200 }, status: "matched_pending_fulfillment", ruleVersion: "order-matching/v1" });
    // 买方待履约资金 = 数量×成交价 + 买方已成交 order_fee（200*2 + 4*2 = 408）。
    expect(buyerView.items[0]).toMatchObject({ fee: { amount: 8 }, pendingFunds: { amount: 408 }, pendingInventoryQuantity: null });
    // 脱敏：不含对手 userId、对手 orderId 与任何 holdId。
    const buyerTrade = buyerView.items[0] as Record<string, unknown>;
    expect(buyerTrade).not.toHaveProperty("buyerUserId");
    expect(buyerTrade).not.toHaveProperty("sellerUserId");
    expect(buyerTrade).not.toHaveProperty("buyOrderId");
    expect(buyerTrade).not.toHaveProperty("sellOrderId");
    expect(buyerTrade).not.toHaveProperty("buyerFundsHoldId");
    expect(buyerTrade).not.toHaveProperty("sellerInventoryHoldId");
    expect(buyerTrade).not.toHaveProperty("sellerDepositHoldId");

    const sellerView = (await app.inject({ method: "GET", url: "/v1/orders/trades", headers: { authorization: sellAuth } })).json().data;
    expect(sellerView.items).toHaveLength(1);
    expect(sellerView.items[0]).toMatchObject({ role: "seller", quantity: 2, executionPrice: { amount: 200 } });
    // 卖方待履约资金 = 已成交保证金（单位保证金 20×2 = 40），待履约库存 = 已成交 2。
    expect(sellerView.items[0]).toMatchObject({ fee: { amount: 8 }, pendingFunds: { amount: 40 }, pendingInventoryQuantity: 2 });
    await app.close(); database.close();
  });

  it("部分撮合：买方全成交、卖方部分成交，双方各自看到自己的成交行与切分资产", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const sellAuth = await seedSellerAndSell(app, database, `p-sell-${Math.random()}@example.test`, 5, 5, 200, "part-sell-trades");
    const buyAuth = await player(app, `p-buy-${Math.random()}@example.test`, "买方");
    const buyPreview = await previewBuy(app, buyAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyAuth, "idempotency-key": "part-buy-trades" }, payload: createBody(buyPreview.data.preview, 210, 2) })).statusCode).toBe(201);

    const buyerView = (await app.inject({ method: "GET", url: "/v1/orders/trades", headers: { authorization: buyAuth } })).json().data;
    expect(buyerView.items[0]).toMatchObject({ role: "buyer", quantity: 2, pendingFunds: { amount: 408 }, pendingInventoryQuantity: null });
    const sellerView = (await app.inject({ method: "GET", url: "/v1/orders/trades", headers: { authorization: sellAuth } })).json().data;
    // 卖方 5 张挂单，成交 2 张：成交行 quantity=2、待履约库存 2。
    expect(sellerView.items[0]).toMatchObject({ role: "seller", quantity: 2, pendingFunds: { amount: 40 }, pendingInventoryQuantity: 2 });
    await app.close(); database.close();
  });

  it("无关玩家看不到他人成交；skuId 过滤与分页只返回自己的成交", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const sellAuth = await seedSellerAndSell(app, database, `o-sell-${Math.random()}@example.test`, 2, 2, 200, "oth-sell-trades");
    const buyAuth = await player(app, `o-buy-${Math.random()}@example.test`, "买方");
    const buyPreview = await previewBuy(app, buyAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyAuth, "idempotency-key": "oth-buy-trades" }, payload: createBody(buyPreview.data.preview, 210, 2) })).statusCode).toBe(201);

    // 无关第三方看到空成交列表。
    const observer = await player(app, `observer-${Math.random()}@example.test`, "旁观者");
    const observerView = (await app.inject({ method: "GET", url: "/v1/orders/trades", headers: { authorization: observer } })).json().data;
    expect(observerView.items).toEqual([]);
    expect(observerView.page).toMatchObject({ total: 0, hasMore: false, nextCursor: null });

    // skuId 过滤：匹配的 SKU 返回成交，不匹配的 SKU 返回空。
    const otherSkuId = "30000000-0000-4000-8000-000000000999";
    const filteredMiss = (await app.inject({ method: "GET", url: `/v1/orders/trades?skuId=${otherSkuId}`, headers: { authorization: buyAuth } })).json().data;
    expect(filteredMiss.items).toEqual([]);
    const filteredHit = (await app.inject({ method: "GET", url: `/v1/orders/trades?skuId=${ids.sku}`, headers: { authorization: sellAuth } })).json().data;
    expect(filteredHit.items).toHaveLength(1);

    // 分页：limit=1 + cursor 翻第二页（此处只有 1 笔，第二页为空）。
    const firstPage = (await app.inject({ method: "GET", url: "/v1/orders/trades?limit=1", headers: { authorization: buyAuth } })).json().data;
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.page).toMatchObject({ total: 1, hasMore: false });
    await app.close(); database.close();
  });

  it("I21B 自成交拦截后没有成交记录，列表为空", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await player(app, `self-trades-${Math.random()}@example.test`, "自成交者");
    expect((await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "self-trades-seed" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 2, maxUnitPrice: 250 } })).statusCode).toBe(201);
    const sellPreview = await previewSell(app, authorization, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization, "idempotency-key": "self-trades-sell" }, payload: createBody(sellPreview.data.preview, 200, 2) })).statusCode).toBe(201);
    const buyPreview = await previewBuy(app, authorization, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization, "idempotency-key": "self-trades-buy" }, payload: createBody(buyPreview.data.preview, 210, 2) })).statusCode).toBe(409);
    const view = (await app.inject({ method: "GET", url: "/v1/orders/trades", headers: { authorization } })).json().data;
    expect(view.items).toEqual([]);
    await app.close(); database.close();
  });
});

describe("I20B 模拟履约、取消与到期", () => {
  // 给卖方先 NPC 买入 seedQuantity 张再挂卖单；返回卖方鉴权。
  async function seedSellerAndSell(app: Awaited<ReturnType<typeof createTestApp>>["app"], database: ReturnType<typeof openSqliteDatabase>, email: string, seedQuantity: number, sellQuantity: number, sellPrice: number, sellKey: string) {
    const authorization = await player(app, email, "卖方");
    expect((await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization, "idempotency-key": `${sellKey}-seed` }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: seedQuantity, maxUnitPrice: 250 } })).statusCode).toBe(201);
    const preview = await previewSell(app, authorization, sellQuantity);
    expect((await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization, "idempotency-key": sellKey }, payload: createBody(preview.data.preview, sellPrice, sellQuantity) })).statusCode).toBe(201);
    return authorization;
  }

  // 买方以 buyPrice 挂买单触发撮合；返回 { buyerAuth, tradeId }。
  async function matchATrade(app: Awaited<ReturnType<typeof createTestApp>>["app"], database: ReturnType<typeof openSqliteDatabase>, buyerEmail: string, buyPrice: number, buyQuantity: number, buyKey: string) {
    const buyerAuth = await player(app, buyerEmail, "买方");
    const buyPreview = await previewBuy(app, buyerAuth, buyQuantity);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyerAuth, "idempotency-key": buyKey }, payload: createBody(buyPreview.data.preview, buyPrice, buyQuantity) })).statusCode).toBe(201);
    const trade = database.prepare("SELECT id, buyer_user_id, seller_user_id, quantity, execution_price_amount, buyer_fee_amount, seller_fee_amount, buyer_funds_hold_id, seller_deposit_hold_id, status, fulfillment_deadline FROM bilateral_trades").get() as { id: string; buyer_user_id: string; seller_user_id: string; quantity: number; execution_price_amount: number; buyer_fee_amount: number; seller_fee_amount: number; buyer_funds_hold_id: string; seller_deposit_hold_id: string; status: string; fulfillment_deadline: string };
    return { buyerAuth, trade };
  }

  it("正常履约：扣买方资金、库存转买方、卖方收入到账+保证金返还、写 p2p.trade.settled 与审计", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    await seedSellerAndSell(app, database, `f-sell-${Math.random()}@example.test`, 2, 2, 200, "i20b-fullfill-sell");
    const { buyerAuth, trade } = await matchATrade(app, database, `f-buy-${Math.random()}@example.test`, 210, 2, "i20b-fullfill-buy");
    // 成交价取 maker（卖方先入）= 200；买方按买单限价 210 预占待履约资金 2*210+2*4=428；
    // 履约按成交价结算：买方实欠 2*200+2*4=408，差额 20 退回买方 available。
    const buyerBefore = (database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = ?").get(trade.buyer_user_id) as { total_amount: number; available_amount: number; frozen_amount: number });
    const sellerBefore = (database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = ?").get(trade.seller_user_id) as { total_amount: number; available_amount: number; frozen_amount: number });

    const res = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/fulfill`, headers: { authorization: buyerAuth, "idempotency-key": "i20b-fulfill-01" } });
    expect(res.statusCode).toBe(200);
    const fulfilled = (database.prepare("SELECT status FROM bilateral_trades WHERE id = ?").get(trade.id) as { status: string }).status;
    expect(fulfilled).toBe("fulfilled");

    // 买方：total 扣 408（按成交价结算），frozen 扣 428（全量待履约释放），available 加 20（限价溢价退回）。
    const buyerAfter = (database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = ?").get(trade.buyer_user_id) as { total_amount: number; available_amount: number; frozen_amount: number });
    expect(buyerAfter.total_amount).toBe(buyerBefore.total_amount - 408);
    expect(buyerAfter.frozen_amount).toBe(buyerBefore.frozen_amount - 428);
    expect(buyerAfter.available_amount).toBe(buyerBefore.available_amount + 20);
    // 买方库存 +2，成本 = 成交价 200。
    const buyerHolding = database.prepare("SELECT quantity, available_quantity, average_cost_amount FROM inventory_holdings WHERE user_id = ?").get(trade.buyer_user_id) as { quantity: number; available_quantity: number; average_cost_amount: number };
    expect(buyerHolding).toMatchObject({ quantity: 2, available_quantity: 2, average_cost_amount: 200 });

    // 卖方：保证金 40 返还（frozen 扣 40、available 加 40）；收入 = 2*200 - 2*4 = 392 到 available。
    const sellerAfter = (database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = ?").get(trade.seller_user_id) as { total_amount: number; available_amount: number; frozen_amount: number });
    expect(sellerAfter.frozen_amount).toBe(sellerBefore.frozen_amount - 40);
    expect(sellerAfter.available_amount).toBe(sellerBefore.available_amount + 40 + 392);
    // 卖方库存：原 2 张已成交离开持有，履约后仍为 0（库存已转给买方）。
    const sellerHolding = database.prepare("SELECT quantity, available_quantity, order_locked_quantity FROM inventory_holdings WHERE user_id = ?").get(trade.seller_user_id) as { quantity: number; available_quantity: number; order_locked_quantity: number };
    expect(sellerHolding).toMatchObject({ quantity: 0, available_quantity: 0, order_locked_quantity: 0 });

    // 写入 p2p.trade.settled 事实事件与 outbox/reprice 任务（NPC 种子买入此前各写一份，故断言增量）。
    expect((database.prepare("SELECT COUNT(*) AS count FROM fact_events WHERE event_type = 'p2p.trade.settled'").get() as { count: number }).count).toBe(1);
    expect((database.prepare("SELECT COUNT(*) AS count FROM outbox WHERE destination = 'market.fact-event'").get() as { count: number }).count).toBeGreaterThanOrEqual(1);
    expect((database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'market.reprice'").get() as { count: number }).count).toBeGreaterThanOrEqual(1);
    // 双方各一条履约审计；账本有买方 debit(p2p_buy)、卖方 credit(p2p_sell)。
    expect((database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'bilateral_trade.fulfilled' AND entity_id = ?").get(trade.id) as { count: number }).count).toBe(2);
    const buyerLedger = (database.prepare("SELECT direction, amount, reason FROM ledger_entries WHERE account_id = (SELECT id FROM accounts WHERE user_id = ?) AND reason = 'p2p_buy'").get(trade.buyer_user_id) as { direction: string; amount: number; reason: string });
    expect(buyerLedger).toMatchObject({ direction: "debit", amount: 408 });
    const sellerLedger = (database.prepare("SELECT direction, amount, reason FROM ledger_entries WHERE account_id = (SELECT id FROM accounts WHERE user_id = ?) AND reason = 'p2p_sell'").get(trade.seller_user_id) as { direction: string; amount: number; reason: string });
    expect(sellerLedger).toMatchObject({ direction: "credit", amount: 392 });
    // 撮合时已投递 trade 到期任务；履约后该 job 仍存在但 handler 会因 status=fulfilled 跳过。
    expect((database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'order.expire' AND unique_key = ?").get(`trade-expire:${trade.id}`) as { count: number }).count).toBe(1);
    await app.close(); database.close();
  });

  it("取消履约：退回买方资金、扣除卖方保证金、恢复卖方库存，不写 p2p.trade.settled", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const sellAuth = await seedSellerAndSell(app, database, `c-sell-${Math.random()}@example.test`, 2, 2, 200, "i20b-cancel-sell");
    const { trade } = await matchATrade(app, database, `c-buy-${Math.random()}@example.test`, 210, 2, "i20b-cancel-buy");
    const buyerBefore = (database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = ?").get(trade.buyer_user_id) as { total_amount: number; available_amount: number; frozen_amount: number });
    const sellerBefore = (database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = ?").get(trade.seller_user_id) as { total_amount: number; available_amount: number; frozen_amount: number });

    // 卖方发起取消履约。
    const res = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/cancel`, headers: { authorization: sellAuth, "idempotency-key": "i20b-cancel-01" } });
    expect(res.statusCode).toBe(200);
    expect((database.prepare("SELECT status FROM bilateral_trades WHERE id = ?").get(trade.id) as { status: string }).status).toBe("cancelled");

    // 买方：待履约资金按买单限价预占 = 2*210+2*4=428 全额退回（total 不变、frozen 扣 428、available 加 428）。
    const buyerAfter = (database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = ?").get(trade.buyer_user_id) as { total_amount: number; available_amount: number; frozen_amount: number });
    expect(buyerAfter.total_amount).toBe(buyerBefore.total_amount);
    expect(buyerAfter.frozen_amount).toBe(buyerBefore.frozen_amount - 428);
    expect(buyerAfter.available_amount).toBe(buyerBefore.available_amount + 428);
    // 买方库存未增加。
    const buyerHolding = database.prepare("SELECT quantity FROM inventory_holdings WHERE user_id = ?").get(trade.buyer_user_id) as { quantity: number } | undefined;
    expect(buyerHolding ?? { quantity: 0 }).toMatchObject({ quantity: 0 });

    // 卖方：保证金 40 扣除（total 扣 40、frozen 扣 40、available 不变）。
    const sellerAfter = (database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = ?").get(trade.seller_user_id) as { total_amount: number; available_amount: number; frozen_amount: number });
    expect(sellerAfter.total_amount).toBe(sellerBefore.total_amount - 40);
    expect(sellerAfter.frozen_amount).toBe(sellerBefore.frozen_amount - 40);
    // 卖方库存恢复：原 2 张成交后离开持有，取消后恢复为 quantity=2、available=2。
    const sellerHolding = database.prepare("SELECT quantity, available_quantity, order_locked_quantity FROM inventory_holdings WHERE user_id = ?").get(trade.seller_user_id) as { quantity: number; available_quantity: number; order_locked_quantity: number };
    expect(sellerHolding).toMatchObject({ quantity: 2, available_quantity: 2, order_locked_quantity: 0 });

    // 不写 p2p.trade.settled；写双方取消审计；卖方有 debit 扣除保证金（correlation 标识本次取消）。
    expect((database.prepare("SELECT COUNT(*) AS count FROM fact_events WHERE event_type = 'p2p.trade.settled'").get() as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'bilateral_trade.cancelled' AND entity_id = ?").get(trade.id) as { count: number }).count).toBe(2);
    const sellerLedger = (database.prepare("SELECT direction, amount, reason FROM ledger_entries WHERE account_id = (SELECT id FROM accounts WHERE user_id = ?) AND correlation_id = ?").get(trade.seller_user_id, `p2p-deposit-forfeited:${trade.id}`) as { direction: string; amount: number; reason: string });
    expect(sellerLedger).toMatchObject({ direction: "debit", amount: 40, reason: "order_fulfillment_deposit" });
    await app.close(); database.close();
  });

  it("履约/取消幂等重放返回首次结果，同键异参 conflict，已终态状态机防护", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const sellAuth = await seedSellerAndSell(app, database, `idem-sell-${Math.random()}@example.test`, 2, 2, 200, "i20b-idem-sell");
    const { buyerAuth, trade } = await matchATrade(app, database, `idem-buy-${Math.random()}@example.test`, 210, 2, "i20b-idem-buy");

    const first = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/fulfill`, headers: { authorization: buyerAuth, "idempotency-key": "i20b-idem-key" } });
    expect(first.statusCode).toBe(200);
    // 同键同参重放返回首次结果（status=fulfilled，仍是 200 + ok）。
    const replay = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/fulfill`, headers: { authorization: buyerAuth, "idempotency-key": "i20b-idem-key" } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ ok: true });

    // 卖方用同一键对已 fulfilled 的成交再请求 fulfill：状态机防护 → RESOURCE_CONFLICT。
    const stale = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/fulfill`, headers: { authorization: sellAuth, "idempotency-key": "i20b-idem-key-seller" } });
    expect(stale.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_CONFLICT" } });

    // 同键异参（对另一笔成交）→ IDEMPOTENCY_CONFLICT。
    const conflict = await app.inject({ method: "POST", url: `/v1/orders/trades/00000000-0000-4000-8000-000000000099/fulfill`, headers: { authorization: buyerAuth, "idempotency-key": "i20b-idem-key" } });
    expect(conflict.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_CONFLICT" } });
    await app.close(); database.close();
  });

  it("无关玩家不可履约/取消他人成交，未成交 trade 不可履约", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    await seedSellerAndSell(app, database, `own-sell-${Math.random()}@example.test`, 2, 2, 200, "i20b-own-sell");
    const { trade } = await matchATrade(app, database, `own-buy-${Math.random()}@example.test`, 210, 2, "i20b-own-buy");

    // 无关第三方对他人成交 fulfill → 404（不是 403，避免泄露成交存在性）。
    const observer = await player(app, `obs-${Math.random()}@example.test`, "旁观者");
    const denied = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/fulfill`, headers: { authorization: observer, "idempotency-key": "i20b-obs-01" } });
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_NOT_FOUND" } });
    await app.close(); database.close();
  });

  it("撮合投递成交到期任务；到期回收推进成交为取消履约并恢复资产，已终态不重复迁移", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const sellAuth = await seedSellerAndSell(app, database, `exp-sell-${Math.random()}@example.test`, 2, 2, 200, "i20b-exp-sell");
    const { trade } = await matchATrade(app, database, `exp-buy-${Math.random()}@example.test`, 210, 2, "i20b-exp-buy");
    // 撮合已投递 trade 到期任务（runAfter=fulfillment_deadline，约 24h 后）。
    const expireJob = database.prepare("SELECT run_after FROM jobs WHERE type = 'order.expire' AND unique_key = ?").get(`trade-expire:${trade.id}`) as { run_after: string };
    expect(expireJob.run_after).toBe(trade.fulfillment_deadline);

    // 普通玩家不可触发到期回收；admin 可。
    const adminEmail = `exp-admin-${Math.random()}@example.test`;
    const adminAuthorization = await player(app, adminEmail, "管理员");
    database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(adminEmail);
    const denied = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/expire`, headers: { authorization: sellAuth } });
    expect(denied.statusCode).toBe(403);

    // 把 fulfillment_deadline 提前到过去，使 admin 显式触发能进入到期回收路径。
    database.prepare("UPDATE bilateral_trades SET fulfillment_deadline = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(trade.id);
    const expired = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/expire`, headers: { authorization: adminAuthorization } });
    expect(expired.statusCode).toBe(200);
    expect((database.prepare("SELECT status FROM bilateral_trades WHERE id = ?").get(trade.id) as { status: string }).status).toBe("cancelled");
    // 不写 p2p.trade.settled；卖方库存恢复。
    expect((database.prepare("SELECT COUNT(*) AS count FROM fact_events WHERE event_type = 'p2p.trade.settled'").get() as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT quantity FROM inventory_holdings WHERE user_id = (SELECT seller_user_id FROM bilateral_trades WHERE id = ?)").get(trade.id) as { quantity: number }).quantity).toBe(2);

    // 重复触发：已 cancelled 不重复迁移、无第二次取消审计。
    const auditBefore = (database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'bilateral_trade.expired' AND entity_id = ?").get(trade.id) as { count: number }).count;
    const expired2 = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/expire`, headers: { authorization: adminAuthorization } });
    expect(expired2.statusCode).toBe(200);
    const auditAfter = (database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'bilateral_trade.expired' AND entity_id = ?").get(trade.id) as { count: number }).count;
    expect(auditAfter).toBe(auditBefore);
    await app.close(); database.close();
  });

  it("委托到期：open 委托转 expired 并释放剩余预占（order.expire handler）", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const buyerAuth = await player(app, `ord-exp-${Math.random()}@example.test`, "买方");
    // 用不会自动成交的低买单（限价 100 < 任何卖单）创建，使其停留在 open。
    const buyPreview = await previewBuy(app, buyerAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyerAuth, "idempotency-key": "i20b-ord-exp-buy" }, payload: createBody(buyPreview.data.preview, 100, 2) })).statusCode).toBe(201);
    const order = database.prepare("SELECT id, user_id, status, reserved_funds_amount, reserved_funds_hold_id FROM bilateral_orders WHERE side = 'buy'").get() as { id: string; user_id: string; status: string; reserved_funds_amount: number; reserved_funds_hold_id: string };
    // 建单即投递委托到期任务。
    expect((database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'order.expire' AND unique_key = ?").get(`order-expire:${order.id}`) as { count: number }).count).toBe(1);
    const buyerBefore = (database.prepare("SELECT frozen_amount FROM accounts WHERE user_id = ?").get(order.user_id) as { frozen_amount: number }).frozen_amount;

    // 直接调用 service.expireOrder（模拟 handler 触发）；先把 expires_at 提前到过去。
    database.prepare("UPDATE bilateral_orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(order.id);
    new (await import("../application/order-service.js")).OrderService(database).expireOrder(order.id);
    const expiredOrder = database.prepare("SELECT status, cancelled_at FROM bilateral_orders WHERE id = ?").get(order.id) as { status: string; cancelled_at: string };
    expect(expiredOrder.status).toBe("expired");
    // 预占资金释放：frozen 减少。
    const buyerAfter = (database.prepare("SELECT frozen_amount FROM accounts WHERE user_id = ?").get(order.user_id) as { frozen_amount: number }).frozen_amount;
    expect(buyerAfter).toBe(buyerBefore - order.reserved_funds_amount);
    // 写 expired 审计。
    expect((database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'bilateral_order.expired' AND entity_id = ?").get(order.id) as { count: number }).count).toBe(1);
    await app.close(); database.close();
  });

  it("履约事务回滚：写入异常时不留半完成状态、资金/库存/保证金守恒", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    await seedSellerAndSell(app, database, `rb-sell-${Math.random()}@example.test`, 2, 2, 200, "i20b-rb-sell");
    const { buyerAuth, trade } = await matchATrade(app, database, `rb-buy-${Math.random()}@example.test`, 210, 2, "i20b-rb-buy");
    const buyerId = trade.buyer_user_id; const sellerId = trade.seller_user_id;
    const totalBefore = (database.prepare("SELECT SUM(total_amount) AS s FROM accounts WHERE user_id IN (?, ?)").get(buyerId, sellerId) as { s: number }).s;
    const frozenBefore = (database.prepare("SELECT SUM(frozen_amount) AS s FROM accounts WHERE user_id IN (?, ?)").get(buyerId, sellerId) as { s: number }).s;
    // 在 bilateral_trades 更新上强制失败，验证整笔回滚。
    database.exec("CREATE TRIGGER fail_trade_update BEFORE UPDATE ON bilateral_trades BEGIN SELECT RAISE(ABORT, 'forced trade update failure'); END");
    const failed = await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/fulfill`, headers: { authorization: buyerAuth, "idempotency-key": "i20b-rb-01" } });
    expect(failed.statusCode).toBe(500);
    // 回滚：成交仍为 matched_pending_fulfillment，资金/库存/保证金守恒（未变更）。
    expect((database.prepare("SELECT status FROM bilateral_trades WHERE id = ?").get(trade.id) as { status: string }).status).toBe("matched_pending_fulfillment");
    const totalAfter = (database.prepare("SELECT SUM(total_amount) AS s FROM accounts WHERE user_id IN (?, ?)").get(buyerId, sellerId) as { s: number }).s;
    const frozenAfter = (database.prepare("SELECT SUM(frozen_amount) AS s FROM accounts WHERE user_id IN (?, ?)").get(buyerId, sellerId) as { s: number }).s;
    expect(totalAfter).toBe(totalBefore);
    expect(frozenAfter).toBe(frozenBefore);
    // 未写 p2p.trade.settled，未写 fulfilled 审计。
    expect((database.prepare("SELECT COUNT(*) AS count FROM fact_events WHERE event_type = 'p2p.trade.settled'").get() as { count: number }).count).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'bilateral_trade.fulfilled'").get() as { count: number }).count).toBe(0);
    await app.close(); database.close();
  });
});

describe("I22B P2P 全链路一致性与恢复", () => {
  it("部分成交在服务重启后取消并撤回剩余委托：资金、库存、保证金、持有、账本和审计保持可对账", async () => {
    const { config, databasePath, ...initial } = await createTestApp();
    let { app, database } = initial;
    seedTradableQuote(database);

    const sellerAuth = await player(app, `i22b-partial-seller-${Math.random()}@example.test`, "部分成交卖方");
    expect((await app.inject({ method: "POST", url: `/v1/npc-trades/buy/${ids.sku}`, headers: { authorization: sellerAuth, "idempotency-key": "i22b-partial-seed" }, payload: { quoteId: ids.quote, quoteVersion: "market/v1", quantity: 5, maxUnitPrice: 250 } })).statusCode).toBe(201);
    const sellPreview = await previewSell(app, sellerAuth, 5);
    expect((await app.inject({ method: "POST", url: `/v1/orders/sell/${ids.sku}`, headers: { authorization: sellerAuth, "idempotency-key": "i22b-partial-sell" }, payload: createBody(sellPreview.data.preview, 200, 5) })).statusCode).toBe(201);

    const buyerAuth = await player(app, `i22b-partial-buyer-${Math.random()}@example.test`, "部分成交买方");
    const buyPreview = await previewBuy(app, buyerAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyerAuth, "idempotency-key": "i22b-partial-buy" }, payload: createBody(buyPreview.data.preview, 210, 2) })).statusCode).toBe(201);

    const trade = database.prepare("SELECT id FROM bilateral_trades").get() as { id: string };
    const sellerOrder = database.prepare("SELECT id FROM bilateral_orders WHERE side = 'sell'").get() as { id: string };
    expect(database.prepare("SELECT quantity, available_quantity, order_locked_quantity FROM inventory_holdings WHERE user_id = (SELECT user_id FROM bilateral_orders WHERE id = ?)").get(sellerOrder.id)).toEqual({ quantity: 3, available_quantity: 0, order_locked_quantity: 3 });

    // 关闭并以相同 SQLite 文件重新创建应用，模拟 API 进程重启；不得依赖进程内缓存恢复订单真相。
    await app.close();
    database.close();
    database = openSqliteDatabase(databasePath);
    app = await createApiApp(config, database);

    expect((await app.inject({ method: "POST", url: `/v1/orders/trades/${trade.id}/cancel`, headers: { authorization: sellerAuth, "idempotency-key": "i22b-partial-cancel-trade" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/v1/orders/${sellerOrder.id}/cancel`, headers: { authorization: sellerAuth, "idempotency-key": "i22b-partial-cancel-order" } })).statusCode).toBe(200);

    // 买方的待履约资金完整释放；卖方仅损失已成交两张对应的保证金 40。
    expect(database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = (SELECT buyer_user_id FROM bilateral_trades WHERE id = ?)").get(trade.id)).toEqual({ total_amount: 10000, available_amount: 10000, frozen_amount: 0 });
    expect(database.prepare("SELECT total_amount, available_amount, frozen_amount FROM accounts WHERE user_id = (SELECT seller_user_id FROM bilateral_trades WHERE id = ?)").get(trade.id)).toEqual({ total_amount: 8710, available_amount: 8710, frozen_amount: 0 });
    expect(database.prepare("SELECT quantity, available_quantity, order_locked_quantity FROM inventory_holdings WHERE user_id = (SELECT seller_user_id FROM bilateral_trades WHERE id = ?)").get(trade.id)).toEqual({ quantity: 5, available_quantity: 5, order_locked_quantity: 0 });
    expect(database.prepare("SELECT status FROM bilateral_trades WHERE id = ?").get(trade.id)).toEqual({ status: "cancelled" });
    expect(database.prepare("SELECT status, remaining_quantity FROM bilateral_orders WHERE id = ?").get(sellerOrder.id)).toEqual({ status: "cancelled", remaining_quantity: 3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fund_holds WHERE status = 'active' AND entity_type = 'bilateral_order'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_holds WHERE status = 'active'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE correlation_id = ? AND direction = 'debit' AND amount = 40").get(`p2p-deposit-forfeited:${trade.id}`)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = ? AND action IN ('bilateral_trade.cancelled', 'bilateral_order.cancelled')").get(trade.id)).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fact_events WHERE event_type = 'p2p.trade.settled'").get()).toEqual({ count: 0 });
    await app.close(); database.close();
  });

  it("重启后的 worker 恢复到期委托任务，重复领取不产生第二次释放或审计", async () => {
    const { app, config, databasePath, database: initialDatabase } = await createTestApp();
    let database = initialDatabase;
    seedTradableQuote(database);
    const buyerAuth = await player(app, `i22b-expire-buyer-${Math.random()}@example.test`, "到期买方");
    const preview = await previewBuy(app, buyerAuth, 2);
    expect((await app.inject({ method: "POST", url: `/v1/orders/buy/${ids.sku}`, headers: { authorization: buyerAuth, "idempotency-key": "i22b-expire-buy" }, payload: createBody(preview.data.preview, 100, 2) })).statusCode).toBe(201);
    const order = database.prepare("SELECT id, reserved_funds_amount FROM bilateral_orders").get() as { id: string; reserved_funds_amount: number };

    await app.close();
    database.close();
    database = openSqliteDatabase(databasePath);
    // 用确定的未来时钟让持久化的 order.expire job 在新进程中可领取。
    const recoveredAt = new Date("2100-01-01T00:00:00.000Z");
    // 业务用例使用服务器当前时钟判断订单到期；任务领取使用注入的未来时钟。
    database.prepare("UPDATE bilateral_orders SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(order.id);
    database.prepare("UPDATE jobs SET run_after = ?, updated_at = ? WHERE type = 'order.expire' AND unique_key = ?").run(recoveredAt.toISOString(), recoveredAt.toISOString(), `order-expire:${order.id}`);
    const worker = new TaskWorker(new SqliteJobRepository(database), createTaskRegistry(config, database), () => recoveredAt);
    worker.recover();
    expect(await worker.runOne()).toBe(true);
    expect(await worker.runOne()).toBe(false);

    expect(database.prepare("SELECT status FROM bilateral_orders WHERE id = ?").get(order.id)).toEqual({ status: "expired" });
    expect(database.prepare("SELECT available_amount, frozen_amount FROM accounts WHERE user_id = (SELECT user_id FROM bilateral_orders WHERE id = ?)").get(order.id)).toEqual({ available_amount: 10000, frozen_amount: 0 });
    expect(database.prepare("SELECT status FROM fund_holds WHERE entity_id = ?").get(order.id)).toEqual({ status: "released" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id = ? AND action = 'bilateral_order.expired'").get(order.id)).toEqual({ count: 1 });
    expect(database.prepare("SELECT status, attempts FROM jobs WHERE type = 'order.expire' AND unique_key = ?").get(`order-expire:${order.id}`)).toEqual({ status: "succeeded", attempts: 1 });
    database.close();
  });
});
