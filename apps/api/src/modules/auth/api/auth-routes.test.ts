import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { AUTH_REQUESTS_PER_MINUTE, AuthenticationRateLimiter } from "./auth-routes.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp(environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mtg-auth-")); directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters", ...environment });
  return { app: await createApiApp(config, database), database };
}
function setCookies(response: { headers: Record<string, unknown> }): string {
  const cookies = response.headers["set-cookie"] as string[];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}
function csrfFrom(cookies: string): string { return decodeURIComponent(cookies.match(/mtg_csrf=([^;]+)/)?.[1] ?? ""); }
const registration = { email: "player@example.test", displayName: "玩家", password: "correct-horse-battery-staple" };

describe("I06 authentication, session and role boundary", () => {
  it("registers with Argon2id, issues secure cookie attributes, and exposes the authenticated session", async () => {
    const { app, database } = await createTestApp();
    const registered = await app.inject({ method: "POST", url: "/v1/auth/register", payload: registration });
    const cookies = setCookies(registered); const accessToken = registered.json().data.accessToken as string;
    const stored = database.prepare("SELECT password_hash FROM users WHERE email = ?").get(registration.email) as { password_hash: string };
    const current = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { authorization: `Bearer ${accessToken}` } });

    expect(registered.statusCode).toBe(201);
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);
    expect(registered.headers["set-cookie"] as string[]).toEqual(expect.arrayContaining([expect.stringContaining("HttpOnly"), expect.stringContaining("SameSite=Strict")]));
    expect(cookies).toContain("mtg_refresh=");
    expect(current.json()).toMatchObject({ ok: true, data: { user: { email: registration.email, role: "player" } } });
    await app.close(); database.close();
  });

  it("rejects bad credentials, expired access tokens, missing CSRF and refresh-token replay", async () => {
    const { app, database } = await createTestApp();
    const registered = await app.inject({ method: "POST", url: "/v1/auth/register", payload: registration });
    const cookies = setCookies(registered); const csrf = csrfFrom(cookies);
    const badLogin = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email: registration.email, password: "incorrect-password-123" } });
    const missingCsrf = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie: cookies } });
    const refreshed = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie: cookies, "x-csrf-token": csrf } });
    const replay = await app.inject({ method: "POST", url: "/v1/auth/refresh", headers: { cookie: cookies, "x-csrf-token": csrf } });
    const newToken = refreshed.json().data.accessToken as string;
    const sid = database.prepare("SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1").get() as { id: string };
    database.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?").run("2000-01-01T00:00:00.000Z", sid.id);
    const expired = await app.inject({ method: "GET", url: "/v1/auth/session", headers: { authorization: `Bearer ${newToken}` } });

    expect(badLogin.statusCode).toBe(401);
    expect(missingCsrf.statusCode).toBe(403);
    expect(refreshed.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(expired.statusCode).toBe(401);
    await app.close(); database.close();
  });

  it("enforces CORS, rate limits, and player/admin route boundaries", async () => {
    const { app, database } = await createTestApp();
    const registered = await app.inject({ method: "POST", url: "/v1/auth/register", payload: registration });
    const accessToken = registered.json().data.accessToken as string;
    const denied = await app.inject({ method: "GET", url: "/v1/admin/jobs", headers: { authorization: `Bearer ${accessToken}` } });
    const crossOrigin = await app.inject({ method: "POST", url: "/v1/auth/login", headers: { origin: "https://attacker.example.test" }, payload: { email: "none@example.test", password: registration.password } });

    expect(denied.statusCode).toBe(403);
    expect(crossOrigin.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close(); database.close();
  });

  it("allows 100 authentication requests per IP per minute and rejects the 101st", () => {
    const limiter = new AuthenticationRateLimiter();
    const now = Date.now();
    expect(Array.from({ length: AUTH_REQUESTS_PER_MINUTE }, () => limiter.check("127.0.0.1", now))).toEqual(Array(AUTH_REQUESTS_PER_MINUTE).fill(true));
    expect(limiter.check("127.0.0.1", now)).toBe(false);
    expect(limiter.check("127.0.0.1", now + 60_001)).toBe(true);
  });
});
