import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { MtgjsonChecksumMismatchError, MtgjsonClient, type MtgjsonPriceSource } from "../../../platform/external/mtgjson/mtgjson-client.js";
import { type PriceSyncLogger, PriceSyncService } from "./price-sync-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const now = "2026-07-26T00:00:00.000Z";
const scryfallId = "20000000-0000-4000-8000-000000000001";
const uuid = "30000000-0000-4000-8000-000000000001";

function database() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-prices-")); directories.push(directory); const result = openSqliteDatabase(join(directory, "test.db"));
  result.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'TST', '夹具系列', 'scryfall', ?)").run("10000000-0000-4000-8000-000000000001", now);
  result.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '夹具卡', '1', ?, 'rare', '{}', 'scryfall', ?, 0, ?, ?)").run(scryfallId, "10000000-0000-4000-8000-000000000001", scryfallId, scryfallId, now, now);
  const insert = result.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, 0, 'scryfall', ?, 0, ?, ?)");
  for (const [finish, id] of [["nonfoil", "40000000-0000-4000-8000-000000000001"], ["foil", "40000000-0000-4000-8000-000000000002"], ["etched", "40000000-0000-4000-8000-000000000003"]] as const) insert.run(id, scryfallId, finish, scryfallId, now, now);
  return result;
}
function source(overrides: Partial<MtgjsonPriceSource> = {}): MtgjsonPriceSource {
  return { version: "5.3.0+fixture", pricesUri: "https://fixture.test/prices", mappingUri: "https://fixture.test/printings", pricesChecksumSha256: "a".repeat(64), mappingChecksumSha256: "b".repeat(64), checksumVerification: "verified", mappings: ["nonfoil", "foil", "etched"].map((finish) => ({ scryfallId, finish: finish as "nonfoil" | "foil" | "etched", mtgjsonUuid: uuid })), prices: new Map([[`${uuid}:normal`, { priceType: "normal" as const, currency: "EUR", amount: 1.23 }], [`${uuid}:foil`, { priceType: "foil" as const, currency: "EUR", amount: 4.56 }], [`${uuid}:etched`, { priceType: "etched" as const, currency: "EUR", amount: 7.89 }]]), ...overrides };
}
function service(db: ReturnType<typeof database>, current: MtgjsonPriceSource, logger?: PriceSyncLogger) { return new PriceSyncService(db, { download: async () => current } as unknown as MtgjsonClient, logger); }

describe("I13B MTGJSON Cardmarket 价格快照", () => {
  it("以版本固定夹具映射 normal/foil/etched，取最新日期的 EUR Trend retail 值并追加不可变快照", async () => {
    const prices = { data: { [uuid]: { paper: { cardmarket: { currency: "EUR", retail: { normal: { "2026-07-24": 1.01, "2026-07-25": 1.23 }, foil: { "2026-07-25": 4.56 }, etched: { "2026-07-25": 7.89 } } } } } }, meta: { date: "2026-07-25" } };
    const printings = { data: { TST: { cards: [{ uuid, finishes: ["nonfoil", "foil", "etched"], identifiers: { scryfallId } }] } }, meta: { version: "5.3.0" } };
    const priceBytes = Buffer.from(JSON.stringify(prices)); const mappingBytes = Buffer.from(JSON.stringify(printings));
    const client = new MtgjsonClient("https://fixture.test/prices", "https://fixture.test/printings", "test", async (url) => {
      const target = String(url); const bytes = target.includes("prices") ? priceBytes : mappingBytes;
      return target.endsWith(".sha256") ? new Response(createHash("sha256").update(bytes).digest("hex")) : new Response(bytes);
    });
    const db = database(); const sync = new PriceSyncService(db, client); await sync.synchronize({ expectedPricesChecksumSha256: createHash("sha256").update(priceBytes).digest("hex"), expectedMappingChecksumSha256: createHash("sha256").update(mappingBytes).digest("hex") });
    expect(db.prepare("SELECT finish, price_type, price_amount, availability FROM price_snapshot_entries ORDER BY finish").all()).toEqual([{ finish: "etched", price_type: "etched", price_amount: 789, availability: "priced" }, { finish: "foil", price_type: "foil", price_amount: 456, availability: "priced" }, { finish: "nonfoil", price_type: "normal", price_amount: 123, availability: "priced" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM price_sku_mappings").get()).toEqual({ count: 3 }); expect(db.prepare("SELECT COUNT(*) AS count FROM card_skus WHERE tradable = 1").get()).toEqual({ count: 3 }); db.close();
  });

  it("零价、非 EUR、缺失价格和重复映射均保留原因并暂停新增交易", async () => {
    const db = database(); const zeroCurrency = new Map(source().prices); zeroCurrency.set(`${uuid}:normal`, { priceType: "normal", currency: "EUR", amount: null }); zeroCurrency.set(`${uuid}:foil`, { priceType: "foil", currency: "USD", amount: 2 }); zeroCurrency.delete(`${uuid}:etched`);
    const duplicate = [...source().mappings, { scryfallId, finish: "etched" as const, mtgjsonUuid: "30000000-0000-4000-8000-000000000099" }]; await service(db, source({ prices: zeroCurrency, mappings: duplicate })).synchronize();
    expect(db.prepare("SELECT finish, availability, unavailable_reason FROM price_snapshot_entries ORDER BY finish").all()).toEqual([{ finish: "etched", availability: "mapping_failed", unavailable_reason: "duplicate_mapping" }, { finish: "foil", availability: "no_price", unavailable_reason: "missing_or_zero_cardmarket_eur" }, { finish: "nonfoil", availability: "no_price", unavailable_reason: "missing_or_zero_cardmarket_eur" }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM card_skus WHERE tradable = 1").get()).toEqual({ count: 0 }); db.close();
  });

  it("checksum 错误或事务中断只追加失败运行，绝不替换最近成功快照", async () => {
    const db = database(); const good = source(); const sync = service(db, good); await sync.synchronize(); const firstRun = sync.status().latestSuccessful?.id;
    await expect(sync.synchronize({ expectedPricesChecksumSha256: "0".repeat(64) })).rejects.toThrow("checksum");
    db.exec("CREATE TRIGGER interrupt_price_snapshot BEFORE INSERT ON price_snapshot_entries BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END;"); await expect(sync.synchronize()).rejects.toThrow("fixture interruption");
    expect(sync.status().latestSuccessful?.id).toBe(firstRun); expect(db.prepare("SELECT COUNT(*) AS count FROM price_snapshot_entries").get()).toEqual({ count: 3 }); expect(db.prepare("SELECT COUNT(*) AS count FROM price_sync_runs WHERE status = 'failed'").get()).toEqual({ count: 2 }); db.close();
  });

  it("在控制台记录校验失败的批次、任务、文件和预期/实际 checksum", async () => {
    const db = database(); const events: Array<{ bindings: Record<string, unknown>; message: string }> = [];
    const logger: PriceSyncLogger = { error: (bindings, message) => events.push({ bindings, message }) };
    const client = { download: async () => { throw new MtgjsonChecksumMismatchError("AllPrintings", "a".repeat(64), "b".repeat(64)); } } as unknown as MtgjsonClient;
    await expect(new PriceSyncService(db, client, logger).synchronize({}, { jobId: "50000000-0000-4000-8000-000000000001", attempt: 2 })).rejects.toThrow("checksum");
    expect(events).toEqual([{
      message: "MTGJSON 价格同步失败",
      bindings: expect.objectContaining({
        event: "price_sync.validation_failed", jobId: "50000000-0000-4000-8000-000000000001", attempt: 2, sourceVersion: null,
        validation: { stage: "provider_checksum", file: "AllPrintings", expectedChecksumSha256: "a".repeat(64), actualChecksumSha256: "b".repeat(64) },
        errorName: "MtgjsonChecksumMismatchError", errorMessage: "MTGJSON AllPrintings 文件 checksum 不匹配", syncRunId: expect.any(String)
      })
    }]);
    db.close();
  });

  it("记录管理员指定 checksum 与下载批次实际值不一致的对应文件", async () => {
    const db = database(); const events: Array<Record<string, unknown>> = [];
    const logger: PriceSyncLogger = { error: (bindings) => events.push(bindings) };
    await expect(service(db, source(), logger).synchronize({ expectedPricesChecksumSha256: "0".repeat(64) }, { jobId: "50000000-0000-4000-8000-000000000002", attempt: 1 })).rejects.toThrow("管理员指定版本");
    expect(events[0]).toEqual(expect.objectContaining({
      event: "price_sync.validation_failed", jobId: "50000000-0000-4000-8000-000000000002", attempt: 1, sourceVersion: "5.3.0+fixture",
      validation: { stage: "expected_checksum", file: "AllPricesToday", expectedChecksumSha256: "0".repeat(64), actualChecksumSha256: "a".repeat(64) }
    }));
    db.close();
  });

  it("只有显式 checksum 覆写才接受未验证下载，并持久化 bypassed 审计状态", async () => {
    const db = database();
    const client = {
      download: async (options: { allowChecksumMismatch?: boolean } = {}) => {
        if (!options.allowChecksumMismatch) throw new MtgjsonChecksumMismatchError();
        return source({ checksumVerification: "bypassed" });
      }
    } as unknown as MtgjsonClient;
    const sync = new PriceSyncService(db, client);
    await expect(sync.synchronize()).rejects.toThrow("checksum");
    await sync.synchronize({ allowChecksumMismatch: true });
    expect(db.prepare("SELECT status, checksum_verification, failure_code FROM price_sync_runs ORDER BY started_at, rowid").all()).toEqual([
      { status: "failed", checksum_verification: "not_verified", failure_code: "CHECKSUM_MISMATCH" },
      { status: "succeeded", checksum_verification: "bypassed", failure_code: null }
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM card_skus WHERE tradable = 1").get()).toEqual({ count: 3 }); db.close();
  });
});
