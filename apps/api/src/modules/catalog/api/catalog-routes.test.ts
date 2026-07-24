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
  const directory = mkdtempSync(join(tmpdir(), "mtg-catalog-")); directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}
function seedCatalog(database: ReturnType<typeof openSqliteDatabase>) {
  const now = "2026-07-24T00:00:00.000Z";
  database.prepare("INSERT INTO card_sets (id, code, name, released_at, source, source_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("10000000-0000-4000-8000-000000000001", "ONE", "Phyrexia: All Will Be One", "2023-02-10", "scryfall", "one", now);
  database.prepare("INSERT INTO card_sets (id, code, name, released_at, source, source_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("10000000-0000-4000-8000-000000000002", "TST", "运营测试系列", null, "manual-test", "operator:fixture", now);
  const printing = database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_text, rarity, legalities_json, artist, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  printing.run("20000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000001", "Elesh Norn, Mother of Machines", "10", "scryfall-one-10", "Vigilance", "mythic", '{"standard":"not_legal"}', "A. Artist", "scryfall", "scryfall-one-10", 0, now, now);
  printing.run("20000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000002", "Elesh Norn, Mother of Machines", "1", null, null, "rare", '{"standard":"legal"}', null, "manual-test", "operator:fixture", 1, now, now);
  const sku = database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  sku.run("30000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001", "nonfoil", 1, "scryfall", "scryfall-one-10", 0, now, now);
  sku.run("30000000-0000-4000-8000-000000000002", "20000000-0000-4000-8000-000000000001", "foil", 1, "scryfall", "scryfall-one-10", 0, now, now);
  sku.run("30000000-0000-4000-8000-000000000003", "20000000-0000-4000-8000-000000000002", "etched", 0, "manual-test", "operator:fixture", 1, now, now);
  database.prepare("INSERT INTO card_image_cache (id, printing_id, source_url, cache_path, status, checksum, cached_at, failure_reason, updated_at) VALUES (?, ?, ?, ?, 'cached', ?, ?, NULL, ?)").run("40000000-0000-4000-8000-000000000001", "20000000-0000-4000-8000-000000000001", "https://img.example.test/one-10.jpg", "catalog/one-10.jpg", "checksum", now, now);
}
async function authorization(app: Awaited<ReturnType<typeof createApiApp>>) {
  const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "catalog@example.test", displayName: "目录玩家", password: "correct-horse-battery-staple" } });
  return `Bearer ${response.json().data.accessToken as string}`;
}
async function adminAuthorization(app: Awaited<ReturnType<typeof createApiApp>>, database: ReturnType<typeof openSqliteDatabase>) {
  await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "catalog-admin@example.test", displayName: "目录管理员", password: "correct-horse-battery-staple" } });
  database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run("catalog-admin@example.test");
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: "catalog-admin@example.test", password: "correct-horse-battery-staple" } });
  return `Bearer ${login.json().data.accessToken as string}`;
}

describe("I08B 卡牌目录与 SKU API", () => {
  it("按 SKU 保留同名不同印刷与工艺，并支持服务端分页和筛选", async () => {
    const { app, database } = await createTestApp(); seedCatalog(database); const token = await authorization(app);
    const first = await app.inject({ method: "GET", url: "/v1/catalog/cards?query=Elesh&limit=2", headers: { authorization: token } });
    const second = await app.inject({ method: "GET", url: "/v1/catalog/cards?query=Elesh&limit=2&cursor=2", headers: { authorization: token } });
    const filtered = await app.inject({ method: "GET", url: "/v1/catalog/cards?setCode=one&finish=foil", headers: { authorization: token } });
    expect(first.statusCode).toBe(200); expect(first.json().data.items).toHaveLength(2); expect(first.json().data.page).toEqual({ total: 3, hasMore: true, nextCursor: "2" });
    expect(second.json().data.items).toHaveLength(1);
    expect(filtered.json().data.items).toEqual([expect.objectContaining({ id: "30000000-0000-4000-8000-000000000002", finish: "foil", source: "scryfall", isManualException: false })]);
    expect(new Set([...first.json().data.items, ...second.json().data.items].map((entry: { id: string }) => entry.id)).size).toBe(3);
    await app.close(); database.close();
  });

  it("详情返回合法性和图片缓存元数据，人工例外永远标注为 manual-test", async () => {
    const { app, database } = await createTestApp(); seedCatalog(database); const token = await authorization(app);
    const cached = await app.inject({ method: "GET", url: "/v1/catalog/cards/30000000-0000-4000-8000-000000000001", headers: { authorization: token } });
    const manual = await app.inject({ method: "GET", url: "/v1/catalog/cards/30000000-0000-4000-8000-000000000003", headers: { authorization: token } });
    expect(cached.json()).toMatchObject({ ok: true, data: { sku: { legalities: { standard: "not_legal" }, image: { path: "/v1/catalog/images/one-10.jpg", status: "cached" } } } });
    expect(manual.json()).toMatchObject({ ok: true, data: { sku: { source: "manual-test", isManualException: true, tradable: false, image: { status: "missing" } } } });
    await app.close(); database.close();
  });

  it("目录读取要求有效会话，非法筛选和未知 SKU 使用稳定错误语义", async () => {
    const { app, database } = await createTestApp(); seedCatalog(database); const token = await authorization(app);
    const anonymous = await app.inject({ method: "GET", url: "/v1/catalog/cards" });
    const invalid = await app.inject({ method: "GET", url: "/v1/catalog/cards?finish=glossy", headers: { authorization: token } });
    const missing = await app.inject({ method: "GET", url: "/v1/catalog/cards/30000000-0000-4000-8000-000000000099", headers: { authorization: token } });
    expect(anonymous.json()).toMatchObject({ ok: false, error: { code: "AUTHENTICATION_INVALID" } });
    expect(invalid.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
    expect(missing.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_NOT_FOUND" } });
    await app.close(); database.close();
  });

  it("只允许管理员查询并幂等投递目录同步和图片缓存任务", async () => {
    const { app, database } = await createTestApp(); const player = await authorization(app); const admin = await adminAuthorization(app, database);
    const denied = await app.inject({ method: "GET", url: "/v1/admin/catalog/sync", headers: { authorization: player } });
    const missingKey = await app.inject({ method: "POST", url: "/v1/admin/catalog/sync", headers: { authorization: admin }, payload: {} });
    const first = await app.inject({ method: "POST", url: "/v1/admin/catalog/sync", headers: { authorization: admin, "idempotency-key": "catalog-sync-key-123" }, payload: {} });
    const replay = await app.inject({ method: "POST", url: "/v1/admin/catalog/sync", headers: { authorization: admin, "idempotency-key": "catalog-sync-key-123" }, payload: {} });
    const image = await app.inject({ method: "POST", url: "/v1/admin/catalog/image-cache", headers: { authorization: admin, "idempotency-key": "catalog-image-key-123" }, payload: { scope: "set", setCode: "one" } });
    const status = await app.inject({ method: "GET", url: "/v1/admin/catalog/sync", headers: { authorization: admin } });
    expect(denied.json()).toMatchObject({ ok: false, error: { code: "AUTHORIZATION_DENIED" } });
    expect(missingKey.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(first.json()).toMatchObject({ ok: true, data: { type: "catalog.sync", status: "pending" } }); expect(replay.json().data.id).toBe(first.json().data.id);
    expect(image.json()).toMatchObject({ ok: true, data: { type: "catalog.image-cache", status: "pending" } });
    expect(status.json()).toMatchObject({ ok: true, data: { latestSuccessful: null, current: null, currentJob: { id: first.json().data.id, type: "catalog.sync", status: "pending" }, currentImageCacheJob: { id: image.json().data.id, type: "catalog.image-cache", status: "pending" } } });
    await app.close(); database.close();
  });
});
