import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase, withinTransaction } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { UserService } from "../application/user-service.js";
import { DailyRolloverService } from "../application/daily-rollover-service.js";

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

describe("I23B 每日工作资金 API", () => {
  it("只接受服务端日切开放的资格，领取需要幂等键且成功后只返回服务端账本结果", async () => {
    const { app, database } = await createTestApp();
    const authorization = await playerAuthorization(app);
    const now = new Date();
    const format = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const local = (type: Intl.DateTimeFormatPartTypes) => format.find((part) => part.type === type)!.value;
    const naturalDate = `${local("year")}-${local("month")}-${local("day")}`;
    const unopened = await app.inject({ method: "POST", url: "/v1/daily-work-funding/claim", headers: { authorization, "idempotency-key": "daily-api-claim-0001" }, payload: {} });
    const archive = await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": "daily-api-archive-0001" }, payload: {} });
    new DailyRolloverService(database).rollover({ naturalDate, timezone: "Asia/Shanghai", workFundingRuleVersion: "daily-work-funds/v1" }, now);
    const status = await app.inject({ method: "GET", url: "/v1/daily-work-funding", headers: { authorization } });
    const claimed = await app.inject({ method: "POST", url: "/v1/daily-work-funding/claim", headers: { authorization, "idempotency-key": "daily-api-claim-0002" }, payload: {} });
    const replay = await app.inject({ method: "POST", url: "/v1/daily-work-funding/claim", headers: { authorization, "idempotency-key": "daily-api-claim-0002" }, payload: {} });
    expect(unopened.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_CONFLICT" } });
    expect(archive.statusCode).toBe(201);
    expect(status.json()).toMatchObject({ ok: true, data: { status: { naturalDate, status: "available", amount: { amount: 1000 }, ruleVersion: "daily-work-funds/v1" } } });
    expect(claimed.statusCode).toBe(201);
    expect(claimed.json()).toMatchObject({ ok: true, data: { funding: { naturalDate, amount: { amount: 1000 }, ruleVersion: "daily-work-funds/v1" } } });
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(claimed.json());
    await app.close(); database.close();
  });
});

describe("I27F 玩家首页聚合快照", () => {
  it("只读返回服务端余额、收藏、今日赛事、市场指数与待办，不创建额外经济流水", async () => {
    const { app, database } = await createTestApp();
    const authorization = await playerAuthorization(app);
    const beforeArchive = await app.inject({ method: "GET", url: "/v1/dashboard", headers: { authorization } });
    await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": "dashboard-archive-0001" }, payload: {} });
    const before = database.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get();
    const overview = await app.inject({ method: "GET", url: "/v1/dashboard", headers: { authorization } });
    const replay = await app.inject({ method: "GET", url: "/v1/dashboard", headers: { authorization } });

    expect(beforeArchive).toMatchObject({ statusCode: 404 });
    expect(overview.json()).toMatchObject({
      ok: true,
      data: {
        overview: {
          balance: { total: { amount: 10_000 }, available: { amount: 10_000 }, frozen: { amount: 0 } },
          netWorth: { amount: 10_000, currency: "GAME_CREDIT" },
          collection: { distinctSkuCount: 0, totalCardCount: 0, marketValue: { amount: 0 }, unpricedSkuCount: 0 },
          marketIndex: { referenceIndex: null, gameIndex: null, quotedSkus: 0 }
        }
      }
    });
    expect(overview.json().data.overview.todos).toEqual(expect.arrayContaining([{ id: "acquire_cards", href: "/packs", label: "获得第一张卡牌" }, { id: "build_deck", href: "/decks/new", label: "构筑合法 Commander 卡组" }]));
    expect(replay.statusCode).toBe(200);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries").get()).toEqual(before);
    await app.close(); database.close();
  });

  it("I35F 有可领取任务奖励时首页待办提供任务中心入口，领取后不再出现", async () => {
    const { app, database } = await createTestApp();
    const authorization = await playerAuthorization(app);
    await app.inject({ method: "POST", url: "/v1/archive", headers: { authorization, "idempotency-key": "dashboard-task-archive-0001" }, payload: {} });
    const userId = (database.prepare("SELECT id FROM users WHERE email = 'archive@example.test'").get() as { id: string }).id;
    const definition = database.prepare("SELECT id FROM task_definitions WHERE id = 'daily-sell-1/v1'").get() as { id: string };
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
    const naturalDate = `${part("year")}-${part("month")}-${part("day")}`;
    // 直接插入一条今日已达标的任务实例（claimable），模拟已结算事实推进完成。
    database.prepare(
      "INSERT INTO task_instances (id, user_id, definition_id, period_key, current_value, status, claimed_at, claimed_idempotency_key, updated_at) VALUES (?, ?, ?, ?, ?, 'claimable', NULL, NULL, ?)"
    ).run("task-instance-i35f", userId, definition.id, naturalDate, 1, now.toISOString());

    const withReward = await app.inject({ method: "GET", url: "/v1/dashboard", headers: { authorization } });
    expect(withReward.json().data.overview.todos).toEqual(expect.arrayContaining([{ id: "claim_task_rewards", label: "领取任务中心奖励", href: "/tasks" }]));
    // 领取后待办消失（首页待办只反映服务端当前可领取状态）。
    database.prepare("UPDATE task_instances SET status = 'claimed', claimed_at = ? WHERE id = ?").run(now.toISOString(), "task-instance-i35f");
    const afterClaim = await app.inject({ method: "GET", url: "/v1/dashboard", headers: { authorization } });
    expect(afterClaim.json().data.overview.todos).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "claim_task_rewards" })]));
    await app.close(); database.close();
  });
});
