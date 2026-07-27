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
