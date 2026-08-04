import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-collection-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

async function player(app: Awaited<ReturnType<typeof createTestApp>>["app"], email: string) {
  const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "收藏玩家", password: "correct-horse-battery-staple" } });
  return `Bearer ${registration.json().data.accessToken as string}`;
}

/**
 * 构造两个系列（PKT 2 个印刷×非闪 SKU、SEC 1 个 SKU），并让玩家持有 PKT 的其中一个 SKU。
 * 完成度：PKT = 1/2 = 5000bp；SEC = 0/1 = 0bp。
 */
function seedSetsAndHoldings(database: ReturnType<typeof openSqliteDatabase>, userId: string) {
  const now = "2026-08-04T00:00:00.000Z";
  const pktSet = "10000000-0000-4000-8000-000000000041";
  const secSet = "10000000-0000-4000-8000-000000000042";
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'PKT', '图鉴测试系列一', 'manual-test', ?)").run(pktSet, now);
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'SEC', '图鉴测试系列二', 'manual-test', ?)").run(secSet, now);
  for (let index = 1; index <= 2; index += 1) {
    const printingId = `20000000-0000-4000-8000-00000000004${index}`;
    const skuId = `30000000-0000-4000-8000-00000000004${index}`;
    database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, 'common', '{}', 'manual-test', 'I33B', 1, ?, ?)").run(printingId, pktSet, `图鉴卡${index}`, String(index), now, now);
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 0, 'manual-test', 'I33B', 1, ?, ?)").run(skuId, printingId, now, now);
    if (index === 1) {
      database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, market_value_captured_at, updated_at) VALUES (?, ?, ?, 2, 2, 0, 0, 100, NULL, NULL, ?)").run(`40000000-0000-4000-8000-00000000004${index}`, userId, skuId, now);
    }
  }
  const secPrinting = "20000000-0000-4000-8000-000000000050";
  const secSku = "30000000-0000-4000-8000-000000000050";
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '第二系列卡', '1', 'rare', '{}', 'manual-test', 'I33B', 1, ?, ?)").run(secPrinting, secSet, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 0, 'manual-test', 'I33B', 1, ?, ?)").run(secSku, secPrinting, now, now);
}

describe("I33B 收藏图鉴只读聚合", () => {
  it("按系列分组返回完成度与未收集卡位，支持仅持有筛选与分页", async () => {
    const { app, database } = await createTestApp();
    const authorization = await player(app, "album@example.test");
    const userId = (database.prepare("SELECT id FROM users WHERE email = 'album@example.test'").get() as { id: string }).id;
    seedSetsAndHoldings(database, userId);

    const anonymous = await app.inject({ method: "GET", url: "/v1/collection/album" });
    expect(anonymous.json()).toMatchObject({ ok: false, error: { code: "AUTHENTICATION_INVALID" } });

    const album = await app.inject({ method: "GET", url: "/v1/collection/album", headers: { authorization } });
    expect(album.json()).toMatchObject({ ok: true });
    const sets = (album.json() as { data: { sets: { items: Array<{ setCode: string; collectedSkuCount: number; totalSkuCount: number; completionBasisPoints: number; uncollectedCards: Array<{ setCode: string; collectorNumber: string; rarity: string }> }>; page: { total: number; hasMore: boolean } } } }).data.sets;
    expect(sets.page.total).toBe(2);
    const byCode = new Map(sets.items.map((item) => [item.setCode, item]));
    expect(byCode.get("PKT")).toMatchObject({ collectedSkuCount: 1, totalSkuCount: 2, completionBasisPoints: 5000 });
    expect(byCode.get("PKT")?.uncollectedCards).toHaveLength(1);
    expect(byCode.get("PKT")?.uncollectedCards[0]).toMatchObject({ setCode: "PKT", collectorNumber: "2", rarity: "common" });
    expect(byCode.get("SEC")).toMatchObject({ collectedSkuCount: 0, totalSkuCount: 1, completionBasisPoints: 0 });
    expect(byCode.get("SEC")?.uncollectedCards).toHaveLength(1);

    const held = await app.inject({ method: "GET", url: "/v1/collection/album?onlyHeld=held", headers: { authorization } });
    const heldSets = held.json().data.sets.items;
    expect(heldSets).toHaveLength(1);
    expect(heldSets[0].setCode).toBe("PKT");

    const paged = await app.inject({ method: "GET", url: "/v1/collection/album?limit=1&cursor=1", headers: { authorization } });
    expect(paged.json().data.sets.items).toHaveLength(1);
    expect(paged.json().data.sets.page.hasMore).toBe(false);

    await app.close(); database.close();
  });

  it("空目录返回空分组，不抛错", async () => {
    const { app, database } = await createTestApp();
    const authorization = await player(app, "album-empty@example.test");
    const album = await app.inject({ method: "GET", url: "/v1/collection/album", headers: { authorization } });
    expect(album.json()).toMatchObject({ ok: true, data: { sets: { items: [], page: { total: 0, hasMore: false } } } });
    await app.close(); database.close();
  });
});
