import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase, withinTransaction } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { UserService } from "../application/user-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-users-")); directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}
async function playerAuthorization(app: Awaited<ReturnType<typeof createApiApp>>): Promise<string> {
  const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: "archive@example.test", displayName: "存档玩家", password: "correct-horse-battery-staple" } });
  return `Bearer ${registration.json().data.accessToken as string}`;
}

describe("I07B 存档、账本与资金冻结", () => {
  it("首次建档只发放一次初始资金，并提供服务端摘要、余额和账本", async () => {
    const { app, database } = await createTestApp(); const authorization = await playerAuthorization(app);
    const missing = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization }, payload: {} });
    const created = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": "archive-create-0001" }, payload: {} });
    const replayed = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": "archive-create-0001" }, payload: {} });
    const summary = await app.inject({ method: "GET", url: "/v1/archive", headers: { authorization } });
    const balance = await app.inject({ method: "GET", url: "/v1/account", headers: { authorization } });
    const ledger = await app.inject({ method: "GET", url: "/v1/ledger?limit=1", headers: { authorization } });

    expect(missing.json()).toMatchObject({ ok: false, error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ ok: true, data: { archive: { initialFundingRuleVersion: "v1", balance: { total: { amount: 10000, currency: "GAME_CREDIT" }, available: { amount: 10000 }, frozen: { amount: 0 } }, netWorth: null } } });
    expect(replayed.statusCode).toBe(200);
    expect(replayed.json()).toEqual(created.json());
    expect(summary.json().data.archive).toEqual(created.json().data.archive);
    expect(balance.json().data.balance).toEqual(created.json().data.archive.balance);
    expect(ledger.json()).toMatchObject({ ok: true, data: { items: [{ direction: "credit", amount: { amount: 10000 }, balanceAfter: { amount: 10000 }, reason: "initial_funding" }], page: { hasMore: false, nextCursor: null } } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM game_archives").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get()).toEqual({ count: 1 });
    await app.close(); database.close();
  });

  it("同键不同请求和并发重复请求不能重复建档或记账", async () => {
    const { app, database } = await createTestApp(); const authorization = await playerAuthorization(app);
    const first = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": "archive-concurrent-01" }, payload: {} });
    const userId = (database.prepare("SELECT id FROM users WHERE email = 'archive@example.test'").get() as { id: string }).id;
    const conflict = new UserService(database).createArchive({ userId, idempotencyKey: "archive-concurrent-01", requestFingerprint: "f".repeat(64), requestId: "request-conflict-0001" });
    const requests = await Promise.all(Array.from({ length: 4 }, () => app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": "archive-concurrent-02" }, payload: {} })));

    expect(first.statusCode).toBe(201);
    expect(conflict).toEqual({ state: "conflict" });
    expect(requests.map((response) => response.statusCode).sort()).toEqual([200, 200, 200, 201]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM game_archives").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get()).toEqual({ count: 1 });
    await app.close(); database.close();
  });

  it("冻结、释放、扣除保持总额=可用额+冻结额，且失败建档完整回滚", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-funds-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES ('user-1', 'fund@example.test', '资金玩家', 'hash', 'player', '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z')").run();
    const users = new UserService(database);
    users.createArchive({ userId: "user-1", idempotencyKey: "funds-create-0001", requestFingerprint: "a".repeat(64), requestId: "request-funds-0001" });
    const reserved = withinTransaction(database, () => users.funds().reserveFunds("user-1", 3000, { entityType: "order", entityId: "order-1", reason: "buy_order_reserve" }, "2026-07-24T00:01:00.000Z"));
    expect(reserved).toMatchObject({ balance: { total: { amount: 10000 }, available: { amount: 7000 }, frozen: { amount: 3000 } } });
    const released = withinTransaction(database, () => users.funds().releaseFunds("user-1", (reserved as { holdId: string }).holdId, "2026-07-24T00:02:00.000Z"));
    expect(released).toMatchObject({ total: { amount: 10000 }, available: { amount: 10000 }, frozen: { amount: 0 } });
    const second = withinTransaction(database, () => users.funds().reserveFunds("user-1", 2500, { entityType: "order", entityId: "order-2", reason: "fulfillment_deposit" }, "2026-07-24T00:03:00.000Z")) as { holdId: string };
    const captured = withinTransaction(database, () => users.funds().captureFunds("user-1", second.holdId, "2026-07-24T00:04:00.000Z", "order:order-2"));
    expect(captured).toMatchObject({ total: { amount: 7500 }, available: { amount: 7500 }, frozen: { amount: 0 } });
    expect(database.prepare("SELECT total_amount = available_amount + frozen_amount AS balanced FROM accounts WHERE user_id = 'user-1'").get()).toEqual({ balanced: 1 });

    database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES ('user-2', 'rollback@example.test', '回滚玩家', 'hash', 'player', '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z')").run();
    database.exec("CREATE TRIGGER reject_initial_ledger BEFORE INSERT ON ledger_entries WHEN NEW.account_id IN (SELECT id FROM accounts WHERE user_id = 'user-2') BEGIN SELECT RAISE(ABORT, 'forced rollback'); END;");
    expect(() => users.createArchive({ userId: "user-2", idempotencyKey: "funds-rollback-01", requestFingerprint: "b".repeat(64), requestId: "request-funds-0002" })).toThrow("forced rollback");
    expect(database.prepare("SELECT COUNT(*) AS count FROM game_archives WHERE user_id = 'user-2'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM accounts WHERE user_id = 'user-2'").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_requests WHERE actor_id = 'user-2'").get()).toEqual({ count: 0 });
    database.close();
  });
});
