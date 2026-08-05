import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";

const directories: string[] = [];
// 服务端按当前 UTC 自然日聚合交易额度；夹具里“当日已用额度”的成交日期必须与运行当天一致，否则该日额度不会生效。
const today = new Date().toISOString().slice(0, 10);
const ids = {
  set: "10000000-0000-4000-8000-000000000171",
  printing: "20000000-0000-4000-8000-000000000171",
  sku: "30000000-0000-4000-8000-000000000171",
  run: "40000000-0000-4000-8000-000000000171",
  snapshot: "50000000-0000-4000-8000-000000000171",
  quote: "60000000-0000-4000-8000-000000000171"
};

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-duplicates-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

function seedTradableQuote(database: ReturnType<typeof openSqliteDatabase>, validUntil = "2099-01-01T00:00:00.000Z") {
  const now = "2026-08-04T00:00:00.000Z";
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'DUP', '重复卡测试系列', 'manual-test', ?)").run(ids.set, now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '重复测试卡', '1', 'common', '{}', 'manual-test', 'I33B', 1, ?, ?)").run(ids.printing, ids.set, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'I33B', 1, ?, ?)").run(ids.sku, ids.printing, now, now);
  database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(ids.run, "a".repeat(64), "b".repeat(64), now, now);
  database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 200, 'priced', NULL, ?, ?)").run(ids.snapshot, ids.run, ids.sku, now, now);
  database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'fixture', 'market/v1', 200, 200, 170, 250, 20, 25, '{}', '[]', ?, ?)").run(ids.quote, ids.sku, ids.snapshot, now, validUntil);
}

async function playerWithHoldings(app: Awaited<ReturnType<typeof createTestApp>>["app"], database: ReturnType<typeof openSqliteDatabase>) {
  const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "dup@example.test", displayName: "重复卡玩家", password: "correct-horse-battery-staple" } });
  const authorization = `Bearer ${registration.json().data.accessToken as string}`;
  const archive = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": "dup-archive-key-01" }, payload: {} });
  expect(archive.statusCode).toBe(201);
  const userId = (database.prepare("SELECT id FROM users WHERE email = 'dup@example.test'").get() as { id: string }).id;
  // 持有 5 张（其中 4 张为可卖出的重复），1 张被订单锁定不可卖。
  database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, market_value_captured_at, updated_at) VALUES (?, ?, ?, 5, 4, 1, 0, 100, NULL, NULL, ?)").run("70000000-0000-4000-8000-000000000171", userId, ids.sku, "2026-08-04T00:00:00.000Z");
  return { authorization, userId };
}

describe("I33B 重复卡批量卖出", () => {
  it("只卖持有量超过 1 的可用库存并保留一张，逐 SKU 复用报价与额度，单事务汇总收入/费用", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const { authorization } = await playerWithHoldings(app, database);
    const request = { method: "POST" as const, url: "/v1/inventory/duplicates/sell", headers: { authorization, "idempotency-key": "dup-sell-key-0001" }, payload: {} };
    const [first, replay] = await Promise.all([app.inject(request), app.inject(request)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 201]);
    const result = (first.statusCode === 201 ? first : replay).json().data.result;
    // 可用 4 张卖 3 张（保留 1 张可用），另 1 张被订单锁定不参与出售；单张卖出价 170、费用 20。
    expect(result).toMatchObject({ cardCount: 3, income: { amount: 510, currency: "GAME_CREDIT" }, fee: { amount: 60, currency: "GAME_CREDIT" } });
    expect(result.soldItems).toHaveLength(1);
    expect(result.soldItems[0]).toMatchObject({ skuId: ids.sku, quantity: 3, unitPrice: { amount: 170 }, unitFee: { amount: 20 }, total: { amount: 510 }, fee: { amount: 60 } });
    expect(result.skippedItems).toEqual([]);
    // 保留 1 张可用 + 1 张锁定；账本、库存流水与成交各一次。
    expect(database.prepare("SELECT quantity, available_quantity, order_locked_quantity FROM inventory_holdings").get()).toEqual({ quantity: 2, available_quantity: 1, order_locked_quantity: 1 });
    // I35B：批量卖出写 npc.trade.settled 时等级同步——净资产跨过 10000 → 等级 2，一次性升级奖励 200 入账（10510 → 10710）。
    expect(database.prepare("SELECT total_amount, available_amount FROM accounts").get()).toEqual({ total_amount: 10710, available_amount: 10710 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE reason = 'level_up_reward'").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT reason, quantity_delta FROM inventory_entries WHERE reason = 'npc_sell_duplicates'").get()).toEqual({ reason: "npc_sell_duplicates", quantity_delta: -3 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM npc_trades WHERE side = 'sell'").get()).toEqual({ count: 1 });
    await app.close(); database.close();
  });

  it("跳过无重复、锁定、报价缺失/过期与额度用尽的 SKU，且不产生部分结算", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const { authorization, userId } = await playerWithHoldings(app, database);
    // 当日卖出额度已用尽：给当前玩家插入一笔已结算当日成交使 remaining=0，所有重复都被跳过。
    database.prepare("INSERT INTO npc_trades (id, user_id, sku_id, side, quote_id, quote_version, unit_price_amount, unit_fee_amount, total_amount, quantity, settlement_date, created_at) VALUES (?, ?, ?, 'sell', ?, 'market/v1', 170, 20, 510, 3, ?, ?)").run("80000000-0000-4000-8000-000000000171", userId, ids.sku, ids.quote, today, `${today}T00:00:00.000Z`);
    database.prepare("UPDATE npc_trade_limits SET max_quantity_per_user_sku_day = 3").run();
    const limited = await app.inject({ method: "POST", url: "/v1/inventory/duplicates/sell", headers: { authorization, "idempotency-key": "dup-sell-limit-01" }, payload: {} });
    expect(limited.statusCode).toBe(201);
    expect(limited.json().data.result).toMatchObject({ cardCount: 0, soldItems: [], skippedItems: [{ skuId: ids.sku, reason: "trade_limit_reached" }] });
    database.prepare("UPDATE npc_trade_limits SET max_quantity_per_user_sku_day = 100").run();
    // 报价过期：全部跳过。
    database.prepare("UPDATE market_quotes SET valid_until = '2000-01-01T00:00:00.000Z'").run();
    const stale = await app.inject({ method: "POST", url: "/v1/inventory/duplicates/sell", headers: { authorization, "idempotency-key": "dup-sell-stale-01" }, payload: {} });
    expect(stale.json().data.result.skippedItems).toEqual([{ skuId: ids.sku, reason: "quote_stale" }]);
    // 请求体 strict：额外字段在 HTTP 边界被拒绝（400 VALIDATION_FAILED），不进入结算。
    const invalidBody = await app.inject({ method: "POST", url: "/v1/inventory/duplicates/sell", headers: { authorization, "idempotency-key": "dup-sell-invalid-01" }, payload: { extra: 1 } });
    expect(invalidBody.statusCode).toBe(400);
    // 未建档存档：批量卖出被拒绝。
    const registration2 = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "dup-norecord@example.test", displayName: "无存档玩家", password: "correct-horse-battery-staple" } });
    const noArchive = await app.inject({ method: "POST", url: "/v1/inventory/duplicates/sell", headers: { authorization: `Bearer ${registration2.json().data.accessToken as string}`, "idempotency-key": "dup-sell-noarchive-01" }, payload: {} });
    expect(noArchive.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_CONFLICT" } });
    await app.close(); database.close();
  });
});
