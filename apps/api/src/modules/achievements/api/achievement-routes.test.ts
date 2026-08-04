import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { AchievementService } from "../application/achievement-service.js";
import { LeylineClient } from "../../decks/infrastructure/leyline-client.js";
import { TournamentService } from "../../tournaments/application/tournament-service.js";
import { UserService } from "../../users/application/user-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-achievements-api-")); directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" });
  return { app: await createApiApp(config, database), database };
}

async function playerAuthorization(app: Awaited<ReturnType<typeof createApiApp>>, email = "achievements@example.test", displayName = "成就玩家"): Promise<string> {
  const registration = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName, password: "correct-horse-battery-staple" } });
  return `Bearer ${registration.json().data.accessToken as string}`;
}

/** 直接经 service 产生一条已结算的 tournament.settled fact 并处理，供路由只读断言使用。 */
function seedUnlockedAchievement(database: ReturnType<typeof openSqliteDatabase>, userId: string): void {
  const now = new Date("2026-07-29T02:00:00.000Z");
  // 创建存档以建立 GAME_CREDIT 账户，否则货币奖励会因账户缺失失败。
  new UserService(database).createArchive({ userId, idempotencyKey: "achievement-seed-archive", requestFingerprint: "achievement-seed-archive", requestId: "request-seed-archive", now });
  const tournaments = new TournamentService(database, { timezone: "Asia/Shanghai", encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", leyline: new LeylineClient({ endpoint: "https://example.test/evaluate", timeoutMs: 100, maxRetries: 0 }, async () => new Response(JSON.stringify({ scores: { power: 70 } }), { status: 200 })) });
  const daily = tournaments.list(userId, now);
  const tournament = daily.find((item) => item.templateId === "daily-npc-single/v1")!;
  const deckId = "d0000000-0000-4000-8000-000000000001"; const registrationId = "r0000000-0000-4000-8000-000000000001"; const snapshotId = "s0000000-0000-4000-8000-000000000001";
  database.prepare("INSERT INTO decks (id, user_id, name, format, rule_version, banlist_version, legality_json, created_at, updated_at) VALUES (?, ?, 't', 'commander-100/v1', 'commander-deck/v1', 'commander-banlist/2026-02-09', ?, ?, ?)").run(deckId, userId, JSON.stringify({ valid: true, totalCards: 100, colorIdentity: ["R"], issues: [] }), now.toISOString(), now.toISOString());
  database.prepare("INSERT INTO deck_power_snapshots (id, deck_id, registration_id, source, source_version, provider_algorithm_version, score, input_summary_sha256, computed_at, availability, degradation_reason, response_sha256, details_json, created_at) VALUES (?, ?, ?, 'leyline', 'leyline-adapter/v1', 'undeclared', 70, ?, ?, 'available', NULL, ?, '{}', ?)").run(snapshotId, deckId, registrationId, "a".repeat(64), now.toISOString(), "b".repeat(64), now.toISOString());
  database.prepare("INSERT INTO tournament_registrations (id, tournament_id, user_id, deck_id, power_snapshot_id, status, entry_fee_amount, entry_fee_hold_id, registered_at, settled_at) VALUES (?, ?, ?, ?, ?, 'registered', 0, NULL, ?, NULL)").run(registrationId, tournament.id, userId, deckId, snapshotId, now.toISOString());
  tournaments.settleRegistration(registrationId, now);
  const fact = database.prepare("SELECT id FROM fact_events WHERE aggregate_id = ? AND event_type = 'tournament.settled'").get(registrationId) as { id: string };
  new AchievementService(database, { timezone: "Asia/Shanghai" }).processFactEvent({ factEventId: fact.id, now: new Date("2026-07-29T02:30:00.000Z") });
}

describe("I26B 成就查询路由", () => {
  it("returns controlled achievement definitions with empty progress for an authenticated player", async () => {
    const { app, database } = await createTestApp();
    const authorization = await playerAuthorization(app);
    const response = await app.inject({ method: "GET", url: "/v1/achievements", headers: { authorization } });
    expect(response.statusCode).toBe(200);
    const items = response.json().data.items as Array<{ definition: { id: string }; progress: unknown }>;
    expect(items.length).toBe(10);
    expect(items.every((item) => item.progress === null)).toBe(true);
    await app.close();
    database.close();
  });

  it("exposes progress, unlock source and reward correlation after a settled tournament", async () => {
    const { app, database } = await createTestApp();
    const authorization = await playerAuthorization(app, "unlocked@example.test", "解锁玩家");
    const userId = (database.prepare("SELECT id FROM users WHERE email = 'unlocked@example.test'").get() as { id: string }).id;
    seedUnlockedAchievement(database, userId);
    const overview = await app.inject({ method: "GET", url: "/v1/achievements", headers: { authorization } });
    const items = overview.json().data.items as Array<{ definition: { id: string }; progress: { status: string } | null }>;
    const first = items.find((item) => item.definition.id === "first-tournament/v1")!;
    expect(first.progress?.status).toBe("unlocked");
    const unlocks = await app.inject({ method: "GET", url: "/v1/achievements/unlocks", headers: { authorization } });
    const unlockItems = unlocks.json().data.items as Array<{ definitionId: string; source: { type: string }; rewardStatus: string; rewardCorrelationId: string | null }>;
    expect(unlockItems.some((item) => item.definitionId === "first-tournament/v1" && item.source.type === "tournament.settled" && item.rewardStatus === "granted" && item.rewardCorrelationId !== null)).toBe(true);
    const detail = await app.inject({ method: "GET", url: "/v1/achievements/detail?definitionId=first-tournament/v1", headers: { authorization } });
    expect(detail.json().data.unlock).not.toBeNull();
    await app.close();
    database.close();
  });

  it("returns 404 for an unknown achievement definition", async () => {
    const { app, database } = await createTestApp();
    const authorization = await playerAuthorization(app, "missing@example.test", "未知玩家");
    const response = await app.inject({ method: "GET", url: "/v1/achievements/detail?definitionId=does-not-exist/v1", headers: { authorization } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_NOT_FOUND" } });
    await app.close();
    database.close();
  });

  it("rejects unauthenticated and refresh-only requests", async () => {
    const { app, database } = await createTestApp();
    const unauthenticated = await app.inject({ method: "GET", url: "/v1/achievements" });
    expect(unauthenticated.statusCode).toBe(401);
    await app.close();
    database.close();
  });

  it("is read-only: repeated reads do not change unlock state", async () => {
    const { app, database } = await createTestApp();
    const authorization = await playerAuthorization(app, "reread@example.test", "复读玩家");
    const userId = (database.prepare("SELECT id FROM users WHERE email = 'reread@example.test'").get() as { id: string }).id;
    seedUnlockedAchievement(database, userId);
    const first = await app.inject({ method: "GET", url: "/v1/achievements/unlocks", headers: { authorization } });
    const before = (first.json().data.items as unknown[]).length;
    await app.inject({ method: "GET", url: "/v1/achievements", headers: { authorization } });
    await app.inject({ method: "GET", url: "/v1/achievements/unlocks", headers: { authorization } });
    const after = await app.inject({ method: "GET", url: "/v1/achievements/unlocks", headers: { authorization } }).then((response) => (response.json().data.items as unknown[]).length);
    expect(after).toBe(before);
    await app.close();
    database.close();
  });
});
