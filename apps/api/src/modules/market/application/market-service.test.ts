import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { MarketService } from "./market-service.js";

const directories: string[] = [];
const now = "2026-07-27T00:00:00.000Z";
const setId = "10000000-0000-4000-8000-000000000001";
const printingId = "20000000-0000-4000-8000-000000000001";
const skuId = "30000000-0000-4000-8000-000000000001";
const snapshotId = "40000000-0000-4000-8000-000000000001";
const runId = "50000000-0000-4000-8000-000000000001";

afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-market-")); directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'TST', '测试系列', 'scryfall', ?)").run(setId, now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '测试卡', '1', ?, 'rare', '{}', 'scryfall', ?, 0, ?, ?)").run(printingId, setId, printingId, printingId, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'scryfall', ?, 0, ?, ?)").run(skuId, printingId, printingId, now, now);
  database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(runId, "a".repeat(64), "b".repeat(64), now, now);
  database.prepare("INSERT INTO price_sync_state (singleton, latest_successful_run_id, updated_at) VALUES (1, ?, ?)").run(runId, now);
  database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 100, 'priced', NULL, ?, ?)").run(snapshotId, runId, skuId, now, now);
  return database;
}

describe("I14B market.reprice", () => {
  it("只消费已结算事实与不可变快照，并发重放同一键不重复叠加报价", async () => {
    const database = fixture();
    const event = { id: "event-1", type: "pack.opened", version: 1, occurredAt: now, correlationId: "opening-1", payload: { userId: "user", packId: "pack", packRuleVersion: "v1", spent: { amount: 500, currency: "GAME_CREDIT" }, received: [{ skuId, quantity: 8 }] } };
    database.prepare("INSERT INTO fact_events (id, event_type, aggregate_type, aggregate_id, version, payload_json, occurred_at) VALUES (?, 'pack.opened', 'pack_opening', 'opening-1', 1, ?, ?)").run("60000000-0000-4000-8000-000000000001", JSON.stringify(event), now);
    database.prepare("INSERT INTO market_events (id, scope_type, scope_id, factor_bps, starts_at, ends_at, reason, created_at) VALUES (?, 'sku', ?, 10100, ?, ?, '测试活动', ?)").run("70000000-0000-4000-8000-000000000001", skuId, "2026-07-26T00:00:00.000Z", "2026-07-28T00:00:00.000Z", now);
    const market = new MarketService(database);
    const results = await Promise.all([
      Promise.resolve().then(() => market.reprice({ priceSyncRunId: runId, triggerKey: "price-sync:fixture" }, now)),
      Promise.resolve().then(() => market.reprice({ priceSyncRunId: runId, triggerKey: "price-sync:fixture" }, now))
    ]);
    expect(results.sort()).toEqual([0, 1]);
    expect(market.quote(skuId)).toMatchObject({ skuId, quoteVersion: "market/v1", referencePrice: { amount: 100, currency: "EUR" }, marketPrice: { currency: "GAME_CREDIT" } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM market_quotes").get()).toEqual({ count: 1 });
    database.close();
  });

  it("事件到期后不再影响新报价，越界事件被数据库约束拒绝", () => {
    const database = fixture();
    const market = new MarketService(database);
    database.prepare("INSERT INTO market_events (id, scope_type, scope_id, factor_bps, starts_at, ends_at, reason, created_at) VALUES (?, 'global', NULL, 15000, ?, ?, '已到期', ?)").run("70000000-0000-4000-8000-000000000002", "2026-07-20T00:00:00.000Z", "2026-07-26T00:00:00.000Z", now);
    market.reprice({ priceSyncRunId: runId, triggerKey: "expired-event" }, now);
    expect(market.quote(skuId)?.marketPrice.amount).toBe(100);
    expect(() => database.prepare("INSERT INTO market_events (id, scope_type, scope_id, factor_bps, starts_at, ends_at, reason, created_at) VALUES (?, 'global', NULL, 20001, ?, ?, '越界', ?)").run("70000000-0000-4000-8000-000000000003", now, "2026-07-28T00:00:00.000Z", now)).toThrow();
    database.close();
  });
});

describe("I17B 价格历史按自然日采样", () => {
  const pricesChecksum = "a".repeat(64);
  const mappingChecksum = "b".repeat(64);
  /** 写入一个历史快照：每个历史日使用独立 run（模拟每日同步），金额 amount 欧分。返回 entryId 供报价引用。 */
  function seedSnapshot(database: ReturnType<typeof fixture>, capturedAt: string, amount: number, index: number): string {
    const entryId = `41000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const historyRunId = `91000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(historyRunId, pricesChecksum, mappingChecksum, capturedAt, capturedAt);
    database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', ?, 'priced', NULL, ?, ?)").run(entryId, historyRunId, skuId, amount, capturedAt, capturedAt);
    return entryId;
  }
  /** 写入一个历史报价：日期为 calculatedAt 当天，金额 amount 游戏币。 */
  function seedQuote(database: ReturnType<typeof fixture>, calculatedAt: string, amount: number, index: number, snapshotEntryId: string) {
    const id = `80000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, ?, 'market/v1', 100, ?, 90, 110, 0, 0, '{}', '[]', ?, ?)").run(id, skuId, snapshotEntryId, `history:${index}`, amount, calculatedAt, calculatedAt);
  }

  /** 清除 fixture 预置的当日快照，使历史测试只包含显式 seed 的历史点。 */
  function clearPresetSnapshot(database: ReturnType<typeof fixture>) {
    database.prepare("DELETE FROM price_snapshot_entries WHERE id = ?").run(snapshotId);
  }

  it("单卡历史按自然日采样，同日多次同步取最新值", () => {
    const database = fixture();
    clearPresetSnapshot(database);
    seedSnapshot(database, "2026-07-20T08:00:00.000Z", 90, 1);
    seedSnapshot(database, "2026-07-20T20:00:00.000Z", 95, 2); // 同日较晚，应覆盖 90
    const latestEntry = seedSnapshot(database, "2026-07-25T08:00:00.000Z", 110, 3);
    seedQuote(database, "2026-07-25T08:00:00.000Z", 105, 1, latestEntry);
    const market = new MarketService(database);
    const history = market.history(skuId, "all", now);
    expect(history.points).toEqual([
      { date: "2026-07-20", referencePrice: { amount: 95, currency: "EUR" }, marketPrice: null },
      { date: "2026-07-25", referencePrice: { amount: 110, currency: "EUR" }, marketPrice: { amount: 105, currency: "GAME_CREDIT" } }
    ]);
    expect(history.referenceSource).toBe("mtgjson-cardmarket");
    database.close();
  });

  it("7d/30d 范围只返回窗口内日期", () => {
    const database = fixture();
    clearPresetSnapshot(database);
    seedSnapshot(database, "2026-06-01T08:00:00.000Z", 80, 1);  // 30d 之外
    seedSnapshot(database, "2026-07-15T08:00:00.000Z", 88, 2);  // 7d 之外、30d 之内
    seedSnapshot(database, "2026-07-25T08:00:00.000Z", 110, 3); // 7d 之内
    const market = new MarketService(database);
    const sevenDays = market.history(skuId, "7d", now);
    expect(sevenDays.points.map((point) => point.date)).toEqual(["2026-07-25"]);
    const thirtyDays = market.history(skuId, "30d", now);
    expect(thirtyDays.points.map((point) => point.date)).toEqual(["2026-07-15", "2026-07-25"]);
    database.close();
  });

  it("无历史快照的 SKU 返回空 points 数组且 referenceSource 为 null", () => {
    const database = fixture();
    // 删除 fixture 预置的快照，模拟该 SKU 完全无历史。
    database.prepare("DELETE FROM price_snapshot_entries WHERE sku_id = ?").run(skuId);
    const market = new MarketService(database);
    const history = market.history(skuId, "all", now);
    expect(history.points).toEqual([]);
    expect(history.referenceSource).toBe(null);
    database.close();
  });

  it("市场指数历史按自然日聚合平均参考价与游戏内价", () => {
    const database = fixture();
    // 用另一个 SKU 制造同日两个快照以验证平均聚合。
    const secondSku = "30000000-0000-4000-8000-000000000002";
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'foil', 1, 'scryfall', ?, 0, ?, ?)").run(secondSku, printingId, printingId, now, now);
    const foilRun = "50000000-0000-4000-8000-000000000002";
    database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(foilRun, pricesChecksum, mappingChecksum, "2026-07-20T08:00:00.000Z", "2026-07-20T08:00:00.000Z");
    database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'foil', 'foil', 'EUR', 200, 'priced', NULL, ?, ?)").run("40000000-0000-4000-8000-000000000099", foilRun, secondSku, "2026-07-20T08:00:00.000Z", "2026-07-20T08:00:00.000Z");
    // 调整主 SKU 快照到 2026-07-20，金额 100（保持引用有效）。
    database.prepare("UPDATE price_snapshot_entries SET captured_at = ?, created_at = ?, price_amount = 100 WHERE id = ?").run("2026-07-20T08:00:00.000Z", "2026-07-20T08:00:00.000Z", snapshotId);
    seedQuote(database, "2026-07-20T08:00:00.000Z", 110, 1, snapshotId);
    const market = new MarketService(database);
    const history = market.indexHistory("all", now);
    expect(history.points).toEqual([{ date: "2026-07-20", referenceIndex: 150, gameIndex: 110 }]);
    database.close();
  });
});
