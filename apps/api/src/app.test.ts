import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "./app.js";
import { loadApiConfig } from "./config/environment.js";
import { openApiDocument, publicApiPaths } from "./openapi.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-api-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const app = await createApiApp(loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db") }), database);
  return { app, database };
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
    const invalid = await app.inject({ method: "GET", url: "/v1/market/quote-preview?buySpread=2" });
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

  it("keeps the checked OpenAPI document aligned with public routes", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(Object.keys(openApiDocument.paths).sort()).toEqual([...publicApiPaths].sort());
  });
});
