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
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, type_line, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '测试卡', '1', ?, 'Legendary Creature — Test', 'rare', '{}', 'scryfall', ?, 0, ?, ?)").run(printingId, setId, printingId, printingId, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'scryfall', ?, 0, ?, ?)").run(skuId, printingId, printingId, now, now);
  database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(runId, "a".repeat(64), "b".repeat(64), now, now);
  database.prepare("INSERT INTO price_sync_state (singleton, latest_successful_run_id, updated_at) VALUES (1, ?, ?)").run(runId, now);
  database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 100, 'priced', NULL, ?, ?)").run(snapshotId, runId, skuId, now, now);
  return database;
}

describe("I14B market.reprice", () => {
  it("只消费已结算事实与不可变快照，并发重放同一键收敛为同日唯一最新报价", async () => {
    const database = fixture();
    const event = { id: "event-1", type: "pack.opened", version: 1, occurredAt: now, correlationId: "opening-1", payload: { userId: "user", packId: "pack", packRuleVersion: "v1", spent: { amount: 500, currency: "GAME_CREDIT" }, received: [{ skuId, quantity: 8 }] } };
    database.prepare("INSERT INTO fact_events (id, event_type, aggregate_type, aggregate_id, version, payload_json, occurred_at) VALUES (?, 'pack.opened', 'pack_opening', 'opening-1', 1, ?, ?)").run("60000000-0000-4000-8000-000000000001", JSON.stringify(event), now);
    database.prepare("INSERT INTO market_events (id, scope_type, scope_id, factor_bps, starts_at, ends_at, reason, created_at) VALUES (?, 'sku', ?, 10100, ?, ?, '测试活动', ?)").run("70000000-0000-4000-8000-000000000001", skuId, "2026-07-26T00:00:00.000Z", "2026-07-28T00:00:00.000Z", now);
    const market = new MarketService(database);
    // I14B→修复：同一 triggerKey 的并发重放经 ON CONFLICT(sku_id,trigger_key) DO UPDATE 收敛。
    // 两次 reprice 都落库（changes 各为 1，无论插入还是覆盖），但 market_quotes 仍按 SKU+triggerKey 唯一为 1 行。
    const results = await Promise.all([
      Promise.resolve().then(() => market.reprice({ priceSyncRunId: runId, triggerKey: "price-sync:fixture" }, now)),
      Promise.resolve().then(() => market.reprice({ priceSyncRunId: runId, triggerKey: "price-sync:fixture" }, now))
    ]);
    expect(results).toEqual([1, 1]);
    expect(market.quote(skuId)).toMatchObject({ skuId, quoteVersion: "market/v1", referencePrice: { amount: 100, currency: "EUR" }, marketPrice: { currency: "GAME_CREDIT" } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM market_quotes").get()).toEqual({ count: 1 });
    database.close();
  });

  it("同日二次 reprice 覆盖刷新报价字段（calculated_at/valid_until 推进），跨日保留各自版本", () => {
    const database = fixture();
    const market = new MarketService(database);
    const day1 = "2026-07-27T00:00:00.000Z";
    const day1Later = "2026-07-27T06:00:00.000Z";
    const day2 = "2026-07-28T00:00:00.000Z";
    // 同日（triggerKey=price-sync:2026-07-27）两次 reprice：第二次应覆盖 calculated_at/valid_until。
    market.reprice({ priceSyncRunId: runId, triggerKey: `price-sync:${day1.slice(0, 10)}` }, day1);
    const firstRow = database.prepare("SELECT calculated_at, valid_until FROM market_quotes WHERE sku_id = ?").get(skuId) as { calculated_at: string; valid_until: string };
    expect(firstRow.calculated_at).toBe(day1);
    market.reprice({ priceSyncRunId: runId, triggerKey: `price-sync:${day1Later.slice(0, 10)}` }, day1Later);
    const overwritten = database.prepare("SELECT calculated_at, valid_until FROM market_quotes WHERE sku_id = ?").get(skuId) as { calculated_at: string; valid_until: string };
    expect(overwritten.calculated_at).toBe(day1Later);
    expect(overwritten.valid_until).not.toBe(firstRow.valid_until);
    // 同日覆盖后仍只有 1 行。
    expect(database.prepare("SELECT COUNT(*) AS count FROM market_quotes").get()).toEqual({ count: 1 });
    // 跨日（不同 triggerKey）保留各自版本，共 2 行。
    market.reprice({ priceSyncRunId: runId, triggerKey: `price-sync:${day2.slice(0, 10)}` }, day2);
    expect(database.prepare("SELECT COUNT(*) AS count FROM market_quotes").get()).toEqual({ count: 2 });
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

describe("I18 卡牌预览", () => {
  it("市场列表把本地图片 cache_path 投影为 /v1/catalog/images 相对路径，无缓存时为 null", () => {
    const database = fixture();
    // 主 SKU 的印刷已缓存图片；cache_path 带子目录前缀，应只取 basename 暴露给浏览器。
    database.prepare("INSERT INTO card_image_cache (id, printing_id, source_url, cache_path, status, checksum, cached_at, updated_at) VALUES (?, ?, 'https://scryfall.example/x', 'images/30000000-0000-4000-8000-000000000001.jpg', 'cached', 'sha', ?, ?)").run("img-1", printingId, now, now);
    // 第二张卡用独立印刷，不缓存图片，用于验证无缓存分支。
    const uncachedPrinting = "20000000-0000-4000-8000-000000000002";
    const uncachedSku = "30000000-0000-4000-8000-000000000002";
    database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '无图测试卡', '2', ?, 'common', '{}', 'scryfall', ?, 0, ?, ?)").run(uncachedPrinting, setId, uncachedPrinting, uncachedPrinting, now, now);
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'scryfall', ?, 0, ?, ?)").run(uncachedSku, uncachedPrinting, uncachedPrinting, now, now);
    const market = new MarketService(database);
    const items = market.list({ sort: "name", direction: "asc", limit: 20 }).items;
    const bySku = new Map(items.map((item) => [item.sku.id, item.sku.imagePath]));
    expect(bySku.get(skuId)).toBe("/v1/catalog/images/30000000-0000-4000-8000-000000000001.jpg");
    expect(bySku.get(uncachedSku)).toBe(null);
    database.close();
  });

  it("组卡采购筛选只返回传奇生物，并携带服务端类别资料", () => {
    const database = fixture();
    const ordinaryPrinting = "20000000-0000-4000-8000-000000000003";
    const ordinarySku = "30000000-0000-4000-8000-000000000003";
    database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, type_line, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '普通生物', '3', ?, 'Creature — Test', 'common', '{}', 'scryfall', ?, 0, ?, ?)").run(ordinaryPrinting, setId, ordinaryPrinting, ordinaryPrinting, now, now);
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'scryfall', ?, 0, ?, ?)").run(ordinarySku, ordinaryPrinting, ordinaryPrinting, now, now);
    const market = new MarketService(database);
    expect(market.list({ cardRole: "commander", tradable: "tradable", sort: "name", direction: "asc", limit: 20 }).items).toEqual([
      expect.objectContaining({ sku: expect.objectContaining({ id: skuId, typeLine: "Legendary Creature — Test" }) })
    ]);
    database.close();
  });
});

describe("I19 市场排序", () => {
  /** 给指定 SKU 插入一条报价；market_quotes 各列经 LEFT JOIN 可为 null，排序时需垫后。entryId 已有则复用，否则新建独立 snapshot。 */
  function seedQuoteFor(database: ReturnType<typeof fixture>, sku: string, referenceCents: number, marketAmount: number, index: number, reuseEntryId?: string) {
    const entryId = reuseEntryId ?? `41000000-0000-4000-8001-${String(index).padStart(12, "0")}`;
    const quoteId = `80000000-0000-4000-8001-${String(index).padStart(12, "0")}`;
    if (!reuseEntryId) database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', ?, 'priced', NULL, ?, ?)").run(entryId, runId, sku, referenceCents, now, now);
    database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, ?, 'market/v1', ?, ?, 90, 110, 0, 0, '{}', '[]', ?, ?)").run(quoteId, sku, entryId, `sort:${index}`, referenceCents, marketAmount, now, now);
  }
  /** 新增一个独立印刷/SKU，可选不插报价（用于验证无报价垫后）。 */
  function addSku(database: ReturnType<typeof fixture>, index: number, name: string): string {
    const printing = `20000000-0000-4000-8002-${String(index).padStart(12, "0")}`;
    const sku = `30000000-0000-4000-8002-${String(index).padStart(12, "0")}`;
    database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'common', '{}', 'scryfall', ?, 0, ?, ?)").run(printing, setId, name, String(index), printing, printing, now, now);
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'scryfall', ?, 0, ?, ?)").run(sku, printing, printing, now, now);
    return sku;
  }

  it("按游戏内中间价与 EUR 参考价排序时，无报价的 SKU 在升降序下都垫后", () => {
    const database = fixture();
    // 甲 marketPrice=500/refCents=200，乙 marketPrice=300/refCents=100，丙无报价。
    seedQuoteFor(database, skuId, 200, 500, 1, snapshotId);
    const skuB = addSku(database, 2, "排序测试卡乙");
    seedQuoteFor(database, skuB, 100, 300, 2);
    const skuC = addSku(database, 3, "排序测试卡丙"); // 不插报价
    const market = new MarketService(database);
    const ids = (opts: { sort: "marketPrice" | "referencePrice"; direction: "asc" | "desc" }) => market.list({ sort: opts.sort, direction: opts.direction, limit: 20 }).items.map((item) => item.sku.id);
    // 有报价者按金额排，无报价的丙在两种方向下都垫后。
    expect(ids({ sort: "marketPrice", direction: "desc" })).toEqual([skuId, skuB, skuC]);
    expect(ids({ sort: "marketPrice", direction: "asc" })).toEqual([skuB, skuId, skuC]);
    expect(ids({ sort: "referencePrice", direction: "desc" })).toEqual([skuId, skuB, skuC]);
    expect(ids({ sort: "referencePrice", direction: "asc" })).toEqual([skuB, skuId, skuC]);
    database.close();
  });

  it("默认按名称升序，与历史行为一致", () => {
    const database = fixture();
    const skuB = addSku(database, 2, "排序测试卡乙");
    const market = new MarketService(database);
    // fixture 主卡名为"测试卡"，乙名为"排序测试卡乙"；按名称升序，乙（排）应在甲（测）之前。
    expect(market.list({ sort: "name", direction: "asc", limit: 20 }).items.map((item) => item.sku.id)).toEqual([skuB, skuId]);
    database.close();
  });
});

describe("I34B 市场热度与公告", () => {
  /** 写入一条历史报价（日期为 calculatedAt 当天），返回 market_quotes id。 */
  function seedQuoteForDay(database: ReturnType<typeof fixture>, targetSkuId: string, calculatedAt: string, amount: number, index: number, snapshotEntryId: string): string {
    const id = `82000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    database.prepare("INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, parameters_json, reasons_json, calculated_at, valid_until) VALUES (?, ?, ?, ?, 'market/v1', 100, ?, 90, 110, 0, 0, '{}', '[]', ?, ?)").run(id, targetSkuId, snapshotEntryId, `heat:${index}`, amount, calculatedAt, calculatedAt);
    return id;
  }

  it("热度按自然日采样计算日内/7 日涨跌榜，无历史基准返回 flat", () => {
    const database = fixture();
    // 主卡：7 月 20 日 100 → 7 月 25 日 120（7 日榜内上涨 2000bp）。
    seedQuoteForDay(database, skuId, "2026-07-20T08:00:00.000Z", 100, 1, snapshotId);
    seedQuoteForDay(database, skuId, "2026-07-25T08:00:00.000Z", 120, 2, snapshotId);
    // 第二张卡只有当日 90（无基准，flat）。
    const secondSku = "30000000-0000-4000-8000-000000000011";
    const secondPrinting = "20000000-0000-4000-8000-000000000011";
    database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '热度乙', '2', ?, 'common', '{}', 'scryfall', ?, 0, ?, ?)").run(secondPrinting, setId, secondPrinting, secondPrinting, now, now);
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'scryfall', ?, 0, ?, ?)").run(secondSku, secondPrinting, secondPrinting, now, now);
    seedQuoteForDay(database, secondSku, "2026-07-25T08:00:00.000Z", 90, 3, snapshotId);
    const market = new MarketService(database);
    const heat = market.heat("2026-07-25T12:00:00.000Z");
    // 甲在 7 日榜为涨幅第 1；乙无基准为 flat 不进入涨跌榜。
    expect(heat.sevenDayGainers).toHaveLength(1);
    expect(heat.sevenDayGainers[0]).toMatchObject({ sku: { id: skuId }, changeBasisPoints: 2000, direction: "up", currentPrice: { amount: 120, currency: "GAME_CREDIT" }, basePrice: { amount: 100, currency: "GAME_CREDIT" } });
    // 日内榜同样只有甲有涨跌幅；乙无基准为 flat、basePrice=null，不进涨跌榜。
    expect(heat.intradayGainers.map((entry) => entry.sku.id)).toEqual([skuId]);
    expect(heat.intradayLosers).toEqual([]);
    const flat = [...heat.intradayGainers, ...heat.intradayLosers, ...heat.sevenDayGainers, ...heat.sevenDayLosers].find((entry) => entry.sku.id === secondSku);
    expect(flat).toBeUndefined();
    database.close();
  });

  it("热度最活跃榜按当日已结算 NPC 成交聚合数量与金额", () => {
    const database = fixture();
    const userId = "80000000-0000-4000-8000-000000000001";
    const quoteId = seedQuoteForDay(database, skuId, "2026-07-25T08:00:00.000Z", 100, 1, snapshotId);
    database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'player', ?, ?)").run(userId, "heat-player@example.test", "热度玩家", "x".repeat(64), now, now);
    database.prepare("INSERT INTO npc_trades (id, user_id, sku_id, side, quote_id, quote_version, unit_price_amount, unit_fee_amount, total_amount, quantity, settlement_date, created_at) VALUES (?, ?, ?, 'sell', ?, 'market/v1', 100, 0, 200, 2, ?, ?)").run("91000000-0000-4000-8000-000000000001", userId, skuId, quoteId, "2026-07-25", "2026-07-25T08:00:00.000Z");
    const market = new MarketService(database);
    const heat = market.heat("2026-07-25T12:00:00.000Z");
    expect(heat.mostActive).toHaveLength(1);
    expect(heat.mostActive[0]).toMatchObject({ sku: { id: skuId }, quantity: 2, turnover: { amount: 200, currency: "GAME_CREDIT" } });
    database.close();
  });

  it("公告只返回生效中的系列周期与市场活动，且不暴露内部系数", () => {
    const database = fixture();
    database.prepare("INSERT INTO market_series_cycles (id, set_id, factor_bps, starts_at, ends_at, reason, created_at) VALUES (?, ?, 12000, ?, ?, '新系列热度', ?)").run("93000000-0000-4000-8000-000000000001", setId, "2026-07-24T00:00:00.000Z", "2026-07-27T00:00:00.000Z", now);
    database.prepare("INSERT INTO market_events (id, scope_type, scope_id, factor_bps, starts_at, ends_at, reason, created_at) VALUES (?, 'global', NULL, 15000, ?, ?, '测试活动', ?)").run("94000000-0000-4000-8000-000000000001", "2026-07-24T00:00:00.000Z", "2026-07-27T00:00:00.000Z", now);
    // 已到期的不返回。
    database.prepare("INSERT INTO market_events (id, scope_type, scope_id, factor_bps, starts_at, ends_at, reason, created_at) VALUES (?, 'global', NULL, 15000, ?, ?, '已到期', ?)").run("94000000-0000-4000-8000-000000000002", "2026-07-10T00:00:00.000Z", "2026-07-20T00:00:00.000Z", now);
    const market = new MarketService(database);
    const result = market.announcements("2026-07-25T12:00:00.000Z");
    expect(result.items).toHaveLength(2);
    const serialized = JSON.parse(JSON.stringify(result.items)) as Array<Record<string, unknown>>;
    for (const item of serialized) {
      expect(item).not.toHaveProperty("factorBps");
      expect(item).not.toHaveProperty("factorBasisPoints");
    }
    expect(result.items.map((item) => item.type).sort()).toEqual(["market_event", "series_cycle"]);
    database.close();
  });

  it("bias 因素进入 reprice 的 reason，且默认中性不改变报价结果", () => {
    const database = fixture();
    const market = new MarketService(database);
    market.reprice({ priceSyncRunId: runId, triggerKey: "bias-neutral" }, now);
    const neutralQuote = market.quote(skuId)!;
    expect(neutralQuote.reasons.some((reason) => reason.kind === "bias" && reason.factorBasisPoints === 10_000 && reason.reason === "NPC 做市商倾向")).toBe(true);
    // 提高倾向（12000 bp）后重新 reprice，报价应有变化且 reason 保留 bias 说明。
    database.prepare("UPDATE market_parameters SET npc_bias_bps = 12000, npc_bias_reason = 'NPC 本周扫货测试系列' WHERE singleton = 1").run();
    market.reprice({ priceSyncRunId: runId, triggerKey: "bias-up" }, now);
    const biasedQuote = market.quote(skuId)!;
    expect(biasedQuote.reasons.some((reason) => reason.kind === "bias" && reason.factorBasisPoints === 12_000 && reason.reason === "NPC 本周扫货测试系列")).toBe(true);
    expect(biasedQuote.marketPrice.amount).toBeGreaterThan(neutralQuote.marketPrice.amount);
    database.close();
  });
});
