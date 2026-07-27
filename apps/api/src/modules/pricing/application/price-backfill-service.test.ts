import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { MtgjsonChecksumMismatchError, type MtgjsonAllPricesSource, type MtgjsonClient } from "../../../platform/external/mtgjson/mtgjson-client.js";
import { type PriceBackfillLogger, PriceBackfillService } from "./price-backfill-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const now = "2026-07-27T00:00:00.000Z";
const scryfallId = "20000000-0000-4000-8000-000000000001";
const uuid = "30000000-0000-4000-8000-000000000001";
const skuId = "40000000-0000-4000-8000-000000000001";

function database() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-backfill-")); directories.push(directory); const result = openSqliteDatabase(join(directory, "test.db"));
  result.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'TST', '夹具系列', 'scryfall', ?)").run("10000000-0000-4000-8000-000000000001", now);
  result.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '夹具卡', '1', ?, 'rare', '{}', 'scryfall', ?, 0, ?, ?)").run(scryfallId, "10000000-0000-4000-8000-000000000001", scryfallId, scryfallId, now, now);
  result.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'scryfall', ?, 0, ?, ?)").run(skuId, scryfallId, scryfallId, now, now);
  return result;
}
const pricesChecksum = "a".repeat(64);
const mappingChecksum = "b".repeat(64);

/** 模拟一次成功的日常同步：写入运行、映射、快照并移动最近成功指针。 */
function seedDailySync(db: ReturnType<typeof database>, runId: string, capturedAt: string, amount: number) {
  db.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, run_kind, priced_skus, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', '5.3.0+daily', 'private', 'private', ?, ?, 'succeeded', 'verified', 'daily', 1, ?, ?)").run(runId, pricesChecksum, mappingChecksum, capturedAt, capturedAt);
  db.prepare("INSERT INTO price_sync_state (singleton, latest_successful_run_id, updated_at) VALUES (1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET latest_successful_run_id = excluded.latest_successful_run_id, updated_at = excluded.updated_at").run(runId, capturedAt);
  db.prepare("INSERT INTO price_sku_mappings (id, sync_run_id, sku_id, scryfall_id, mtgjson_uuid, finish, created_at) VALUES (?, ?, ?, ?, ?, 'nonfoil', ?)").run("60000000-0000-4000-8000-000000000001", runId, skuId, scryfallId, uuid, capturedAt);
  db.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, ?, 'nonfoil', 'normal', 'EUR', ?, 'priced', NULL, ?, ?)").run("70000000-0000-4000-8000-000000000001", runId, skuId, uuid, amount, capturedAt, capturedAt);
}
function historySource(overrides: Partial<MtgjsonAllPricesSource> = {}): MtgjsonAllPricesSource {
  return {
    version: "5.3.0+history",
    pricesUri: "https://fixture.test/allprices",
    pricesChecksumSha256: "c".repeat(64),
    checksumVerification: "verified",
    prices: new Map([
      [`${uuid}:normal`, [
        { priceType: "normal", currency: "EUR", date: "2026-07-20", amount: 0.90 },
        { priceType: "normal", currency: "EUR", date: "2026-07-25", amount: 1.10 },
        { priceType: "normal", currency: "EUR", date: "2026-07-27", amount: 1.23 }
      ]]
    ]),
    ...overrides
  };
}
function service(db: ReturnType<typeof database>, source: MtgjsonAllPricesSource, logger?: PriceBackfillLogger) { return new PriceBackfillService(db, { downloadAllPrices: async () => source } as unknown as MtgjsonClient, logger); }

describe("I17B MTGJSON AllPrices 历史回填", () => {
  it("按 SKU/工艺/日期只追加缺失的历史快照，不覆盖已有每日同步写入", async () => {
    const db = database();
    seedDailySync(db, "80000000-0000-4000-8000-000000000001", "2026-07-27T00:00:00.000Z", 123);
    await service(db, historySource()).backfill({}, { jobId: "job-1", attempt: 1 });
    // 日常同步已存在 2026-07-27（123 欧分）；回填应跳过该日，只补 07-20 和 07-25。
    const entries = db.prepare("SELECT substr(captured_at, 1, 10) AS day, price_amount FROM price_snapshot_entries WHERE availability = 'priced' ORDER BY day").all() as Array<{ day: string; price_amount: number }>;
    expect(entries).toEqual([
      { day: "2026-07-20", price_amount: 90 },
      { day: "2026-07-25", price_amount: 110 },
      { day: "2026-07-27", price_amount: 123 }
    ]);
    const status = service(db, historySource()).status().latestRun!;
    expect(status.status).toBe("succeeded");
    expect(status.insertedEntries).toBe(2);
    expect(status.skippedExistingEntries).toBe(1);
    expect(status.backfilledFromDate).toBe("2026-07-20");
    expect(status.backfilledToDate).toBe("2026-07-25");
    db.close();
  });

  it("同版本重放不重复追加，且不移动日常同步最近成功指针", async () => {
    const db = database();
    seedDailySync(db, "80000000-0000-4000-8000-000000000001", "2026-07-27T00:00:00.000Z", 123);
    const svc = service(db, historySource());
    await svc.backfill();
    const firstCount = (db.prepare("SELECT COUNT(*) AS count FROM price_snapshot_entries WHERE availability = 'priced'").get() as { count: number }).count;
    const pointerBefore = (db.prepare("SELECT latest_successful_run_id FROM price_sync_state WHERE singleton = 1").get() as { latest_successful_run_id: string }).latest_successful_run_id;
    await svc.backfill();
    const secondCount = (db.prepare("SELECT COUNT(*) AS count FROM price_snapshot_entries WHERE availability = 'priced'").get() as { count: number }).count;
    const pointerAfter = (db.prepare("SELECT latest_successful_run_id FROM price_sync_state WHERE singleton = 1").get() as { latest_successful_run_id: string }).latest_successful_run_id;
    expect(secondCount).toBe(firstCount);
    expect(pointerAfter).toBe(pointerBefore);
    expect(pointerAfter).toBe("80000000-0000-4000-8000-000000000001");
    db.close();
  });

  it("回填不移动每日同步进度指针，也不为历史日投递 market.reprice", async () => {
    const db = database();
    seedDailySync(db, "80000000-0000-4000-8000-000000000001", "2026-07-27T00:00:00.000Z", 123);
    await service(db, historySource()).backfill();
    const schedule = db.prepare("SELECT last_scheduled_date FROM price_sync_schedule_state WHERE singleton = 1").get() as { last_scheduled_date: string };
    expect(schedule.last_scheduled_date).toBe("1970-01-01");
    const repriceJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'market.reprice'").get() as { count: number };
    expect(repriceJobs.count).toBe(0);
    db.close();
  });

  it("无映射的 SKU 不参与回填且不改变其 tradable 状态", async () => {
    const db = database();
    // 不 seed 日常同步，因此无 price_sku_mappings。
    await service(db, historySource()).backfill();
    const entries = db.prepare("SELECT COUNT(*) AS count FROM price_snapshot_entries WHERE availability = 'priced'").get() as { count: number };
    expect(entries.count).toBe(0);
    const status = service(db, historySource()).status().latestRun!;
    expect(status.insertedEntries).toBe(0);
    db.close();
  });

  it("checksum 失败只追加失败运行，不留半批次且不替换已有快照", async () => {
    const db = database();
    seedDailySync(db, "80000000-0000-4000-8000-000000000001", "2026-07-27T00:00:00.000Z", 123);
    const client = { downloadAllPrices: async () => { throw new MtgjsonChecksumMismatchError("AllPrices", "d".repeat(64), "e".repeat(64)); } } as unknown as MtgjsonClient;
    await expect(new PriceBackfillService(db, client).backfill()).rejects.toThrow("checksum");
    const entries = db.prepare("SELECT COUNT(*) AS count FROM price_snapshot_entries WHERE availability = 'priced'").get() as { count: number };
    expect(entries.count).toBe(1); // 仅原有每日同步快照
    const failedRuns = db.prepare("SELECT COUNT(*) AS count FROM price_sync_runs WHERE run_kind = 'backfill' AND status = 'failed'").get() as { count: number };
    expect(failedRuns.count).toBe(1);
    db.close();
  });

  it("expected checksum 与实际不一致时记录对应文件并失败", async () => {
    const db = database();
    const events: Array<Record<string, unknown>> = [];
    const logger: PriceBackfillLogger = { error: (bindings) => events.push(bindings) };
    await expect(service(db, historySource(), logger).backfill({ expectedPricesChecksumSha256: "0".repeat(64) }, { jobId: "job-2", attempt: 1 })).rejects.toThrow("管理员指定版本");
    expect(events[0]).toEqual(expect.objectContaining({
      event: "price_backfill.validation_failed", jobId: "job-2", attempt: 1,
      validation: { stage: "expected_checksum", file: "AllPrices", expectedChecksumSha256: "0".repeat(64), actualChecksumSha256: "c".repeat(64) }
    }));
    db.close();
  });

  it("事务中断不留半批次回填条目", async () => {
    const db = database();
    seedDailySync(db, "80000000-0000-4000-8000-000000000001", "2026-07-27T00:00:00.000Z", 123);
    db.exec("CREATE TRIGGER interrupt_backfill BEFORE INSERT ON price_snapshot_entries BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END;");
    await expect(service(db, historySource()).backfill()).rejects.toThrow("fixture interruption");
    const backfillEntries = db.prepare("SELECT COUNT(*) AS count FROM price_snapshot_entries").get() as { count: number };
    expect(backfillEntries.count).toBe(1); // 仅原有每日同步快照；回填子运行整体回滚
    db.close();
  });
});
