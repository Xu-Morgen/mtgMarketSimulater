import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "./app.js";
import { loadApiConfig } from "./config/environment.js";
import { openApiDocument, publicApiPaths } from "./openapi.js";
import { MarketService } from "./modules/market/application/market-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-api-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const app = await createApiApp(loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" }), database);
  return { app, database };
}

async function adminAuthorization(app: Awaited<ReturnType<typeof createApiApp>>, database: ReturnType<typeof openSqliteDatabase>): Promise<string> {
  const email = "admin@example.test";
  await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "管理员", password: "correct-horse-battery-staple" } });
  database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: "correct-horse-battery-staple" } });
  return `Bearer ${login.json().data.accessToken as string}`;
}

describe("API cross-cutting HTTP boundary", () => {
  it("returns a request-correlated envelope for liveness and readiness", async () => {
    const { app, database } = await createTestApp();
    const health = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": "request-123" } });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(health.headers["x-request-id"]).toBe("request-123");
    expect(health.json()).toMatchObject({ ok: true, data: { status: "ok", database: { storage: "sqlite-wal" } }, meta: { requestId: "request-123" } });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, data: { status: "ready", database: { status: "ok" }, jobs: {} } });
    await app.close();
    database.close();
  });

  it("uses the standard failure envelope for query validation and unknown routes", async () => {
    const { app, database } = await createTestApp();
    const invalid = await app.inject({ method: "POST", url: "/v1/auth/register", payload: {} });
    const missing = await app.inject({ method: "GET", url: "/does-not-exist" });

    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" }, meta: { requestId: expect.any(String) } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_NOT_FOUND" }, meta: { requestId: expect.any(String) } });
    await app.close();
    database.close();
  });

  it("allows only configured browser origins", async () => {
    const { app, database } = await createTestApp();
    const allowed = await app.inject({ method: "GET", url: "/health", headers: { origin: "http://localhost:3000" } });
    const blocked = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://untrusted.example.test" } });

    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(blocked.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
    database.close();
  });

  it("writes a credential-free audit summary for a successful mutating route", async () => {
    const { app, database } = await createTestApp();
    app.post("/test/write", async () => ({ accepted: true }));
    const response = await app.inject({ method: "POST", url: "/test/write", headers: { "idempotency-key": "idem-key-123", authorization: "Bearer should-not-be-stored" } });

    expect(response.statusCode).toBe(200);
    expect(database.prepare("SELECT action, entity_type, entity_id, request_id, summary_json FROM audit_logs").get()).toMatchObject({
      action: "HTTP POST",
      entity_type: "http_route",
      entity_id: "/test/write",
      request_id: expect.any(String),
      summary_json: JSON.stringify({ statusCode: 200, idempotencyKey: "idem-key-123" })
    });
    await app.close();
    database.close();
  });

  it("provides task enqueue, query, unique-key de-duplication and manual retry", async () => {
    const { app, database } = await createTestApp();
    const authorization = await adminAuthorization(app, database);
    const body = { type: "prices.sync", payload: { sourceVersion: "test" }, uniqueKey: "2026-07-24" };
    const missingKey = await app.inject({ method: "POST", url: "/v1/admin/jobs", headers: { authorization }, payload: body });
    const created = await app.inject({ method: "POST", url: "/v1/admin/jobs", headers: { authorization, "idempotency-key": "idem-job-123" }, payload: body });
    const duplicate = await app.inject({ method: "POST", url: "/v1/admin/jobs", headers: { authorization, "idempotency-key": "idem-job-456" }, payload: body });
    const id = created.json().data.id as string;
    database.prepare("UPDATE jobs SET status = 'dead' WHERE id = ?").run(id);
    const retried = await app.inject({ method: "POST", url: `/v1/admin/jobs/${id}/retry`, headers: { authorization, "idempotency-key": "idem-retry-123" } });
    const listed = await app.inject({ method: "GET", url: "/v1/admin/jobs?status=pending", headers: { authorization } });

    expect(missingKey.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(created.statusCode).toBe(201);
    expect(duplicate.json().data.id).toBe(id);
    expect(retried.json()).toMatchObject({ ok: true, data: { id, status: "pending", attempt: 0 } });
    expect(listed.json().data.items).toEqual([expect.objectContaining({ id, type: "prices.sync" })]);
    await app.close();
    database.close();
  });

  it("restricts price sync status and idempotent task dispatch to administrators", async () => {
    const { app, database } = await createTestApp();
    const anonymous = await app.inject({ method: "GET", url: "/v1/admin/prices/sync" }); const authorization = await adminAuthorization(app, database);
    const missing = await app.inject({ method: "POST", url: "/v1/admin/prices/sync", headers: { authorization }, payload: {} });
    const first = await app.inject({ method: "POST", url: "/v1/admin/prices/sync", headers: { authorization, "idempotency-key": "price-sync-key-123" }, payload: {} });
    const replay = await app.inject({ method: "POST", url: "/v1/admin/prices/sync", headers: { authorization, "idempotency-key": "price-sync-key-123" }, payload: {} });
    const status = await app.inject({ method: "GET", url: "/v1/admin/prices/sync", headers: { authorization } });
    expect(anonymous.json()).toMatchObject({ ok: false, error: { code: "AUTHENTICATION_INVALID" } }); expect(missing.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(first.json()).toMatchObject({ ok: true, data: { type: "prices.sync", status: "pending" } }); expect(replay.json().data.id).toBe(first.json().data.id); expect(status.json()).toMatchObject({ ok: true, data: { latestSuccessful: null, current: null, currentJob: { id: first.json().data.id, type: "prices.sync" } } });
    await app.close(); database.close();
  });

  it("requires an administrator and records one explicit audit fact for a checksum-bypass task", async () => {
    const { app, database } = await createTestApp();
    const authorization = await adminAuthorization(app, database);
    const unavailable = await app.inject({ method: "POST", url: "/v1/admin/prices/sync", headers: { authorization, "idempotency-key": "price-bypass-key-none" }, payload: { allowChecksumMismatch: true } });
    database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, failure_code, failure_reason, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'unavailable', 'private', 'private', 'unavailable', 'unavailable', 'failed', 'not_verified', 'CHECKSUM_MISMATCH', 'MTGJSON 文件 checksum 不匹配', ?, ?)").run("10000000-0000-4000-8000-000000000099", "2026-07-26T00:00:00.000Z", "2026-07-26T00:00:00.000Z");
    const first = await app.inject({ method: "POST", url: "/v1/admin/prices/sync", headers: { authorization, "idempotency-key": "price-bypass-key-123" }, payload: { allowChecksumMismatch: true } });
    const replay = await app.inject({ method: "POST", url: "/v1/admin/prices/sync", headers: { authorization, "idempotency-key": "price-bypass-key-123" }, payload: { allowChecksumMismatch: true } });
    const job = first.json().data;
    const audit = database.prepare("SELECT actor_id, action, entity_type, entity_id, summary_json FROM audit_logs WHERE action = 'price_sync.checksum_bypass_requested'").all();

    expect(unavailable).toMatchObject({ statusCode: 409 }); expect(first.statusCode).toBe(201); expect(replay.json().data.id).toBe(job.id);
    expect(database.prepare("SELECT payload_json FROM jobs WHERE id = ?").get(job.id)).toEqual({ payload_json: JSON.stringify({ allowChecksumMismatch: true }) });
    expect(audit).toEqual([expect.objectContaining({ action: "price_sync.checksum_bypass_requested", entity_type: "job", entity_id: job.id, summary_json: JSON.stringify({ taskType: "prices.sync", checksumVerification: "bypassed" }) })]);
    await app.close(); database.close();
  });

  it("only exposes the public price freshness fields to players", async () => {
    const { app, database } = await createTestApp();
    const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "player@example.test", displayName: "玩家", password: "correct-horse-battery-staple" } });
    const authorization = `Bearer ${registration.json().data.accessToken as string}`;
    const completedAt = "2026-07-26T08:00:00.000Z";
    database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, mapped_skus, priced_skus, unpriced_skus, mapping_failed_skus, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 12, 9, 2, 1, ?, ?)").run("10000000-0000-4000-8000-000000000001", "a".repeat(64), "b".repeat(64), completedAt, completedAt);
    database.prepare("INSERT INTO price_sync_state (singleton, latest_successful_run_id, updated_at) VALUES (1, ?, ?)").run("10000000-0000-4000-8000-000000000001", completedAt);
    database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, failure_reason, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'unavailable', 'private', 'private', 'unavailable', 'unavailable', 'failed', 'fixture failure', ?, ?)").run("10000000-0000-4000-8000-000000000002", completedAt, completedAt);
    const publicStatus = await app.inject({ method: "GET", url: "/v1/prices/status", headers: { authorization } });
    const adminStatus = await app.inject({ method: "GET", url: "/v1/admin/prices/sync", headers: { authorization } });

    expect(publicStatus.json()).toEqual(expect.objectContaining({ ok: true, data: { source: "mtgjson-cardmarket", updatedAt: completedAt, freshness: "stale" } }));
    expect(JSON.stringify(publicStatus.json())).not.toContain("checksum");
    expect(JSON.stringify(publicStatus.json())).not.toContain("mappedSkus");
    expect(adminStatus.statusCode).toBe(403);
    expect(adminStatus.json()).toMatchObject({ ok: false, error: { code: "AUTHORIZATION_DENIED" } });
    await app.close(); database.close();
  });

  it("only returns persisted server market quotes and index to authenticated players", async () => {
    const { app, database } = await createTestApp();
    const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "market-player@example.test", displayName: "市场玩家", password: "correct-horse-battery-staple" } });
    const authorization = `Bearer ${registration.json().data.accessToken as string}`;
    const now = "2026-07-27T00:00:00.000Z"; const setId = "10000000-0000-4000-8000-000000000010"; const printingId = "20000000-0000-4000-8000-000000000010"; const skuId = "30000000-0000-4000-8000-000000000010"; const runId = "40000000-0000-4000-8000-000000000010";
    database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'MRK', '市场测试', 'scryfall', ?)").run(setId, now);
    database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, rarity, legalities_json, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '市场测试卡', '1', ?, 'rare', '{}', 'scryfall', ?, 0, ?, ?)").run(printingId, setId, printingId, printingId, now, now);
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 1, 'scryfall', ?, 0, ?, ?)").run(skuId, printingId, printingId, now, now);
    database.prepare("INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', 'fixture', 'private', 'private', ?, ?, 'succeeded', 'verified', ?, ?)").run(runId, "a".repeat(64), "b".repeat(64), now, now);
    database.prepare("INSERT INTO price_sync_state (singleton, latest_successful_run_id, updated_at) VALUES (1, ?, ?)").run(runId, now);
    database.prepare("INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, NULL, 'nonfoil', 'normal', 'EUR', 123, 'priced', NULL, ?, ?)").run("50000000-0000-4000-8000-000000000010", runId, skuId, now, now);
    new MarketService(database).reprice({ priceSyncRunId: runId, triggerKey: "route-fixture" }, now);
    const quote = await app.inject({ method: "GET", url: `/v1/market/quotes/${skuId}`, headers: { authorization } });
    const index = await app.inject({ method: "GET", url: "/v1/market/index", headers: { authorization } });
    const anonymous = await app.inject({ method: "GET", url: `/v1/market/quotes/${skuId}` });
    expect(quote.json()).toMatchObject({ ok: true, data: { quote: { skuId, referencePrice: { amount: 123, currency: "EUR" } } } });
    expect(index.json()).toMatchObject({ ok: true, data: { quotedSkus: 1, referenceIndex: 123 } });
    expect(anonymous.statusCode).toBe(401);
    await app.close(); database.close();
  });

  it("keeps the checked OpenAPI document aligned with public routes", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(Object.keys(openApiDocument.paths).sort()).toEqual([...publicApiPaths].sort());
  });
});
