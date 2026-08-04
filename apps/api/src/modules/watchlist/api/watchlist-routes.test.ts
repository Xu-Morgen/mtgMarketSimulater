import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { WatchlistService } from "../application/watchlist-service.js";

const directories: string[] = [];
const ids = {
  set: "10000000-0000-4000-8000-000000000251",
  printing: "20000000-0000-4000-8000-000000000251",
  sku: "30000000-0000-4000-8000-000000000251",
  run: "40000000-0000-4000-8000-000000000251",
  snapshot: "50000000-0000-4000-8000-000000000251",
  quote: "60000000-0000-4000-8000-000000000251"
};

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-watchlist-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

/** 预置可交易报价：market_price=200、reference=200，valid_until 可调以驱动提醒命中。 */
function seedTradableQuote(database: ReturnType<typeof openSqliteDatabase>, marketPrice = 200, referencePrice = 200, validUntil = "2099-01-01T00:00:00.000Z") {
  const now = "2026-08-04T00:00:00.000Z";
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'WL', '提醒测试系列', 'manual-test', ?)").run(ids.set, now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '提醒测试卡', '1', 'common', '{}', 'manual-test', 'I34B', 1, ?, ?)").run(ids.printing, ids.set, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'manual-test', 'I34B', 1, ?, ?)").run(ids.sku, ids.printing, now, now);
  database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(ids.run, "a".repeat(64), "b".repeat(64), now, now);
  database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', ?, 'priced', NULL, ?, ?)").run(ids.snapshot, ids.run, ids.sku, referencePrice, now, now);
  database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'fixture', 'market/v1', ?, ?, 170, 250, 20, 25, '{}', '[]', ?, ?)").run(ids.quote, ids.sku, ids.snapshot, referencePrice, marketPrice, now, validUntil);
}

async function registerPlayer(app: Awaited<ReturnType<typeof createTestApp>>["app"], email: string) {
  const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "提醒玩家", password: "correct-horse-battery-staple" } });
  return `Bearer ${registration.json().data.accessToken as string}`;
}

describe("I34B Watchlist 价格提醒", () => {
  it("新增/更新/删除条目，每 SKU 去重，额度上限拒绝超额", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await registerPlayer(app, "wl@example.test");
    const upsert = { method: "POST" as const, url: "/v1/watchlist", headers: { authorization, "idempotency-key": "wl-upsert-0001" }, payload: { skuId: ids.sku, targetType: "game_price", direction: "at_or_below", targetAmount: 180, enabled: true } };
    const [first, replay] = await Promise.all([app.inject(upsert), app.inject(upsert)]);
    expect([first.statusCode, replay.statusCode].sort()).toEqual([200, 200]);
    const item = (first.statusCode === 200 ? first : replay).json().data;
    expect(item).toMatchObject({ skuId: ids.sku, targetType: "game_price", targetAmount: 180, enabled: true });
    // 同 SKU 再次 upsert 为更新（不新增行）。
    const update = await app.inject({ method: "POST", url: "/v1/watchlist", headers: { authorization, "idempotency-key": "wl-upsert-0002" }, payload: { skuId: ids.sku, targetType: "game_price", direction: "at_or_below", targetAmount: 150, enabled: true } });
    expect(update.statusCode).toBe(200);
    expect(database.prepare("SELECT COUNT(*) AS count FROM watchlist_items").get()).toEqual({ count: 1 });
    // 删除（幂等重放同键返回相同结果）。
    const remove = { method: "DELETE" as const, url: `/v1/watchlist/${ids.sku}`, headers: { authorization, "idempotency-key": "wl-remove-0001" } };
    const [removed, removedReplay] = await Promise.all([app.inject(remove), app.inject(remove)]);
    expect([removed.statusCode, removedReplay.statusCode].sort()).toEqual([200, 200]);
    expect((removed.statusCode === 200 ? removed : removedReplay).json().data).toEqual({ removed: true });
    expect(database.prepare("SELECT COUNT(*) AS count FROM watchlist_items").get()).toEqual({ count: 0 });
    // 额度上限：单例改为 2 后，第 3 个不同 SKU 被拒绝（RULE_VIOLATION）。
    database.prepare("UPDATE watchlist_limits SET max_items_per_user = 2").run();
    const secondSku = "30000000-0000-4000-8000-000000000252";
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'foil', 1, 'manual-test', 'I34B', 1, ?, ?)").run(secondSku, ids.printing, "2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
    const thirdSku = "30000000-0000-4000-8000-000000000253";
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'etched', 1, 'manual-test', 'I34B', 1, ?, ?)").run(thirdSku, ids.printing, "2026-08-04T00:00:00.000Z", "2026-08-04T00:00:00.000Z");
    for (const sku of [ids.sku, secondSku]) {
      await app.inject({ method: "POST", url: "/v1/watchlist", headers: { authorization, "idempotency-key": `wl-limit-${sku}` }, payload: { skuId: sku, targetType: "game_price", direction: "at_or_below", targetAmount: 180, enabled: true } });
    }
    const overLimit = await app.inject({ method: "POST", url: "/v1/watchlist", headers: { authorization, "idempotency-key": "wl-over-limit-01" }, payload: { skuId: thirdSku, targetType: "game_price", direction: "at_or_below", targetAmount: 180, enabled: true } });
    expect(overLimit.statusCode).toBe(409);
    expect(overLimit.json().error.code).toBe("RULE_VIOLATION");
    // 请求体 strict：额外字段 400，不进入结算。
    const invalid = await app.inject({ method: "POST", url: "/v1/watchlist", headers: { authorization, "idempotency-key": "wl-invalid-01" }, payload: { skuId: ids.sku, targetType: "game_price", direction: "at_or_below", targetAmount: 180, enabled: true, extra: 1 } });
    expect(invalid.statusCode).toBe(400);
    await app.close(); database.close();
  });

  it("提醒任务命中判定幂等：同一报价只产生一次提醒，不同报价各提醒一次，停用条目不提醒", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database, 200, 200);
    const authorization = await registerPlayer(app, "wl-alert@example.test");
    // 目标价 180（当前 200 未命中）；先降低报价到 150（命中），再触发 checkAlerts。
    await app.inject({ method: "POST", url: "/v1/watchlist", headers: { authorization, "idempotency-key": "wl-alert-upsert-01" }, payload: { skuId: ids.sku, targetType: "game_price", direction: "at_or_below", targetAmount: 180, enabled: true } });
    database.prepare("UPDATE market_quotes SET market_price_amount = 150, valid_until = '2099-01-01T00:00:00.000Z' WHERE id = ?").run(ids.quote);
    const service = new WatchlistService(database);
    const firstRun = service.checkAlerts("2026-08-04T01:00:00.000Z");
    expect(firstRun.triggered).toBe(1);
    // 同一报价重复检测不产生第二条提醒（唯一约束收敛）。
    expect(service.checkAlerts("2026-08-04T01:00:00.000Z").triggered).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM watchlist_alerts").get()).toEqual({ count: 1 });
    // 新增一条报价（新 quote id）后再次检测，产生第二条提醒。
    database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'fixture2', 'market/v1', 200, 140, 170, 250, 20, 25, '{}', '[]', ?, '2099-01-01T00:00:00.000Z')").run("61000000-0000-4000-8000-000000000251", ids.sku, ids.snapshot, "2026-08-04T02:00:00.000Z");
    expect(service.checkAlerts("2026-08-04T02:00:00.000Z").triggered).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM watchlist_alerts").get()).toEqual({ count: 2 });
    // 未读/已读：标记已读后未读数下降，重复标记幂等成功。
    const alerts = await app.inject({ method: "GET", url: "/v1/watchlist/alerts", headers: { authorization } });
    expect(alerts.json().data.unreadCount).toBe(2);
    const alertId = alerts.json().data.items[0].id as string;
    const read = await app.inject({ method: "POST", url: `/v1/watchlist/alerts/${alertId}/read`, headers: { authorization, "idempotency-key": "wl-read-0001" } });
    expect(read.statusCode).toBe(200);
    const after = await app.inject({ method: "GET", url: "/v1/watchlist/alerts", headers: { authorization } });
    expect(after.json().data.unreadCount).toBe(1);
    const readAgain = await app.inject({ method: "POST", url: `/v1/watchlist/alerts/${alertId}/read`, headers: { authorization, "idempotency-key": "wl-read-0002" } });
    expect(readAgain.statusCode).toBe(200);
    // 停用条目不再产生新提醒。
    await app.inject({ method: "POST", url: "/v1/watchlist", headers: { authorization, "idempotency-key": "wl-disable-01" }, payload: { skuId: ids.sku, targetType: "game_price", direction: "at_or_below", targetAmount: 180, enabled: false } });
    const beforeDisable = database.prepare("SELECT COUNT(*) AS count FROM watchlist_alerts").get() as { count: number };
    database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, 'fixture3', 'market/v1', 200, 130, 170, 250, 20, 25, '{}', '[]', ?, '2099-01-01T00:00:00.000Z')").run("61000000-0000-4000-8000-000000000252", ids.sku, ids.snapshot, "2026-08-04T03:00:00.000Z");
    expect(service.checkAlerts("2026-08-04T03:00:00.000Z").triggered).toBe(0);
    expect((database.prepare("SELECT COUNT(*) AS count FROM watchlist_alerts").get() as { count: number }).count).toBe(beforeDisable.count);
    await app.close(); database.close();
  });

  it("越权：不能读取/标记他人的提醒；未知 SKU 与未知提醒返回 404", async () => {
    const { app, database } = await createTestApp();
    seedTradableQuote(database);
    const authorization = await registerPlayer(app, "wl-a@example.test");
    const other = await registerPlayer(app, "wl-b@example.test");
    await app.inject({ method: "POST", url: "/v1/watchlist", headers: { authorization, "idempotency-key": "wl-other-upsert-01" }, payload: { skuId: ids.sku, targetType: "game_price", direction: "at_or_below", targetAmount: 180, enabled: true } });
    database.prepare("UPDATE market_quotes SET market_price_amount = 150 WHERE id = ?").run(ids.quote);
    const service = new WatchlistService(database);
    service.checkAlerts("2026-08-04T01:00:00.000Z");
    // 他人标记已读：404 且不改动提醒。
    const alertId = (database.prepare("SELECT id FROM watchlist_alerts LIMIT 1").get() as { id: string }).id;
    const crossRead = await app.inject({ method: "POST", url: `/v1/watchlist/alerts/${alertId}/read`, headers: { authorization: other, "idempotency-key": "wl-cross-read-01" } });
    expect(crossRead.statusCode).toBe(404);
    expect((database.prepare("SELECT read_at FROM watchlist_alerts WHERE id = ?").get(alertId) as { read_at: string | null }).read_at).toBeNull();
    // 未知 SKU upsert：404。
    const unknownSku = await app.inject({ method: "POST", url: "/v1/watchlist", headers: { authorization, "idempotency-key": "wl-unknown-sku-01" }, payload: { skuId: "00000000-0000-4000-8000-000000000000", targetType: "game_price", direction: "at_or_below", targetAmount: 180, enabled: true } });
    expect(unknownSku.statusCode).toBe(404);
    // 无存档玩家仍可管理 Watchlist（纯提醒，不依赖经济存档）。
    const noArchive = await registerPlayer(app, "wl-noarchive@example.test");
    const list = await app.inject({ method: "GET", url: "/v1/watchlist", headers: { authorization: noArchive } });
    expect(list.statusCode).toBe(200);
    await app.close(); database.close();
  });
});
