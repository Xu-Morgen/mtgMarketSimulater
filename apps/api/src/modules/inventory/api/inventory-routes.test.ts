import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import type { InventoryHoldingDto } from "@mtg-market/contracts";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { InventoryService } from "../application/inventory-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function seed(database: ReturnType<typeof openSqliteDatabase>): void {
  const now = "2026-07-24T00:00:00.000Z";
  database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES ('player-1', 'inventory@example.test', '库存玩家', 'hash', 'player', ?, ?)").run(now, now);
  database.prepare("INSERT INTO card_sets (id, code, name, released_at, source, source_reference, created_at) VALUES ('set-1', 'TST', '测试系列', NULL, 'manual-test', NULL, ?)").run(now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_text, rarity, legalities_json, artist, source, source_reference, is_manual_exception, created_at, updated_at) VALUES ('printing-1', 'set-1', '库存测试卡', '1', NULL, NULL, 'common', '{}', NULL, 'manual-test', NULL, 1, ?, ?)").run(now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES ('11111111-1111-4111-8111-111111111111', 'printing-1', 'nonfoil', 1, 'manual-test', NULL, 1, ?, ?)").run(now, now);
}
function testDatabase() { const directory = mkdtempSync(join(tmpdir(), "mtg-inventory-")); directories.push(directory); const database = openSqliteDatabase(join(directory, "test.db")); seed(database); return database; }

describe("I10B 库存、锁定与对账", () => {
  it("并发锁定、释放与扣减均不产生负数、超额锁定或幽灵库存", () => {
    const database = testDatabase(); const inventory = new InventoryService(database); const skuId = "11111111-1111-4111-8111-111111111111";
    const acquired = inventory.acquire({ userId: "player-1", skuId, quantityDelta: 5, unitCostAmount: 200, reason: "pack_opened", correlationId: "pack-1", now: "2026-07-24T00:01:00.000Z" });
    expect(acquired).toMatchObject({ quantity: 5, availableQuantity: 5, averageCost: { amount: 200 } });
    const locks = ["order-1", "order-2", "order-3"].map((entityId) => inventory.lock({ userId: "player-1", skuId, quantity: 2, target: { reason: "order", entityType: "order", entityId }, correlationId: entityId, now: "2026-07-24T00:02:00.000Z" }));
    expect(locks.filter((value) => typeof value === "object")).toHaveLength(2);
    expect(locks).toContain("insufficient");
    const first = locks.find((value): value is { holdId: string; holding: InventoryHoldingDto } => typeof value === "object")!;
    expect(inventory.release({ userId: "player-1", holdId: first.holdId, correlationId: "release-1", now: "2026-07-24T00:03:00.000Z" })).toMatchObject({ quantity: 5, availableQuantity: 3, orderLockedQuantity: 2 });
    const second = locks.find((value): value is { holdId: string; holding: InventoryHoldingDto } => typeof value === "object" && value.holdId !== first.holdId)!;
    expect(inventory.capture({ userId: "player-1", holdId: second.holdId, correlationId: "capture-1", now: "2026-07-24T00:04:00.000Z" })).toMatchObject({ quantity: 3, availableQuantity: 3, orderLockedQuantity: 0 });
    expect(inventory.release({ userId: "player-1", holdId: second.holdId, correlationId: "release-again", now: "2026-07-24T00:05:00.000Z" })).toBe("not-active");
    expect(database.prepare("SELECT quantity = available_quantity + order_locked_quantity + tournament_locked_quantity AS balanced, quantity >= 0 AS non_negative FROM inventory_holdings").get()).toEqual({ balanced: 1, non_negative: 1 });
    expect(inventory.reconciliation("player-1", skuId, undefined, 20)).toMatchObject({ reconciled: true, entries: { items: expect.arrayContaining([expect.objectContaining({ reason: "pack_opened" }), expect.objectContaining({ reason: "order_captured" })]) } });
    database.close();
  });

  it("库存与调用方账本写入在同一事务失败时完整回滚", () => {
    const database = testDatabase(); const inventory = new InventoryService(database); const skuId = "11111111-1111-4111-8111-111111111111";
    expect(() => inventory.acquire({ userId: "player-1", skuId, quantityDelta: 1, unitCostAmount: 100, reason: "forced_failure", correlationId: "failure-1", now: "2026-07-24T00:01:00.000Z" }, () => { throw new Error("ledger write failed"); })).toThrow("ledger write failed");
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_holdings").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM inventory_entries").get()).toEqual({ count: 0 });
    database.close();
  });

  it("库存总览、筛选、单卡持仓和对账 API 均只读取当前玩家数据", async () => {
    const database = testDatabase(); const skuId = "11111111-1111-4111-8111-111111111111";
    new InventoryService(database).acquire({ userId: "player-1", skuId, quantityDelta: 2, unitCostAmount: 100, reason: "fixture", correlationId: "fixture-1", now: "2026-07-24T00:01:00.000Z" });
    const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: ":memory:", AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" }); const app = await createApiApp(config, database);
    const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "api-inventory@example.test", displayName: "接口玩家", password: "correct-horse-battery-staple" } });
    const userId = (database.prepare("SELECT id FROM users WHERE email = 'api-inventory@example.test'").get() as { id: string }).id;
    new InventoryService(database).acquire({ userId, skuId, quantityDelta: 2, unitCostAmount: 100, reason: "api_fixture", correlationId: "api-fixture-1", now: "2026-07-24T00:02:00.000Z" });
    const unauthorized = await app.inject({ method: "GET", url: "/v1/inventory" });
    const authorization = `Bearer ${registration.json().data.accessToken as string}`;
    const list = await app.inject({ method: "GET", url: "/v1/inventory?setCode=TST&sort=name", headers: { authorization } });
    const detail = await app.inject({ method: "GET", url: `/v1/inventory/${skuId}`, headers: { authorization } });
    const reconciliation = await app.inject({ method: "GET", url: `/v1/inventory/${skuId}/reconciliation`, headers: { authorization } });
    expect(unauthorized.statusCode).toBe(401);
    expect(list.json()).toMatchObject({ ok: true, data: { page: { total: 1 } } });
    expect(list.json().data.items[0]).toMatchObject({ skuId, quantity: 2, availableQuantity: 2, averageCost: { amount: 100 } });
    expect(detail.json()).toMatchObject({ ok: true, data: { holding: { skuId, marketValue: null, marketValueUnavailableReason: "no_snapshot" } } });
    expect(reconciliation.json()).toMatchObject({ ok: true, data: { skuId, reconciled: true, entries: { items: [expect.objectContaining({ reason: "api_fixture" })] } } });
    await app.close(); database.close();
  });
});
