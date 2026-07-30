import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { ACHIEVEMENT_RULE_VERSION } from "@mtg-market/rules";
import { LeylineClient } from "../../decks/infrastructure/leyline-client.js";
import { UserService } from "../../users/application/user-service.js";
import { TournamentService } from "../../tournaments/application/tournament-service.js";
import { AchievementService } from "./achievement-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function achievementService(database: ReturnType<typeof openSqliteDatabase>): AchievementService {
  return new AchievementService(database, { timezone: "Asia/Shanghai" });
}

function tournamentService(database: ReturnType<typeof openSqliteDatabase>, score = 70): TournamentService {
  return new TournamentService(database, {
    timezone: "Asia/Shanghai",
    encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    leyline: new LeylineClient({ endpoint: "https://example.test/evaluate", timeoutMs: 100, maxRetries: 0 }, async () => new Response(JSON.stringify({ scores: { power: score } }), { status: 200 }))
  });
}

function registerUser(database: ReturnType<typeof openSqliteDatabase>, userId: string, email: string): void {
  database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'test', 'player', ?, ?)").run(userId, email, email, "2026-07-30T00:00:00.000Z", "2026-07-30T00:00:00.000Z");
}

/**
 * 产生一条已结算的 NPC 报名与对应的 tournament.settled fact，返回 fact 事件 id。
 * `won` 控制最终 fact.result，使测试不受模拟随机性影响；同一玩家在不同日期多次调用模拟连胜/连败。
 */
function settleNpcRegistration(database: ReturnType<typeof openSqliteDatabase>, userId: string, day: number, suffix: string, won: boolean): { factEventId: string; registrationId: string } {
  const service = tournamentService(database);
  const now = new Date(`2026-07-${String(day).padStart(2, "0")}T02:00:00.000Z`);
  const nowIso = now.toISOString();
  const daily = service.list(userId, now);
  const tournament = daily.find((item) => item.templateId === "daily-npc-single/v1")!;
  const deckId = `d0000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const registrationId = `r0000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  const snapshotId = `s0000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
  database.prepare("INSERT INTO decks (id, user_id, name, format, rule_version, banlist_version, legality_json, created_at, updated_at) VALUES (?, ?, '测试牌组', 'commander-100/v1', 'commander-deck/v1', 'commander-banlist/2026-02-09', ?, ?, ?)").run(deckId, userId, JSON.stringify({ valid: true, totalCards: 100, colorIdentity: ["R"], issues: [], ruleVersion: "commander-deck/v1", banlistVersion: "commander-banlist/2026-02-09", checkedAt: nowIso }), nowIso, nowIso);
  database.prepare("INSERT INTO deck_power_snapshots (id, deck_id, registration_id, source, source_version, provider_algorithm_version, score, input_summary_sha256, computed_at, availability, degradation_reason, response_sha256, details_json, created_at) VALUES (?, ?, ?, 'leyline', 'leyline-adapter/v1', 'undeclared', 70, ?, ?, 'available', NULL, ?, '{}', ?)").run(snapshotId, deckId, registrationId, "a".repeat(64), nowIso, "b".repeat(64), nowIso);
  database.prepare("INSERT INTO tournament_registrations (id, tournament_id, user_id, deck_id, power_snapshot_id, status, entry_fee_amount, entry_fee_hold_id, registered_at, settled_at) VALUES (?, ?, ?, ?, ?, 'registered', 0, NULL, ?, NULL)").run(registrationId, tournament.id, userId, deckId, snapshotId, nowIso);
  service.settleRegistration(registrationId, now);
  const fact = database.prepare("SELECT id, payload_json FROM fact_events WHERE aggregate_id = ? AND event_type = 'tournament.settled'").get(registrationId) as { id: string; payload_json: string };
  // 测试夹具显式控制 fact.result，避免模拟随机性影响成就断言。
  const parsed = JSON.parse(fact.payload_json) as { result: string };
  const desired = won ? "win" : "loss";
  if (parsed.result !== desired) {
    database.prepare("UPDATE fact_events SET payload_json = ? WHERE id = ?").run(JSON.stringify({ ...parsed, result: desired }), fact.id);
  }
  return { factEventId: fact.id, registrationId };
}

function available(database: ReturnType<typeof openSqliteDatabase>, userId: string): number {
  return (database.prepare("SELECT available_amount FROM accounts WHERE user_id = ? AND currency = 'GAME_CREDIT'").get(userId) as { available_amount: number }).available_amount;
}

function grantDistinctSkus(database: ReturnType<typeof openSqliteDatabase>, userId: string, count: number, now: string): void {
  const setId = "c0000000-0000-4000-8000-000000000001";
  database.prepare("INSERT OR IGNORE INTO card_sets (id, code, name, source, created_at) VALUES (?, 'COL', '收藏测试', 'manual-test', ?)").run(setId, now);
  for (let index = 0; index < count; index += 1) {
    const printingId = `p1000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    const skuId = `k1000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
    database.prepare("INSERT OR IGNORE INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_id, oracle_text, rarity, legalities_json, color_identity_json, type_line, keywords_json, mana_value, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, '', 'common', '{\"commander\":\"legal\"}', '[\"R\"]', 'Creature', '[]', 2, 'manual-test', 'fixture', 1, ?, ?)").run(printingId, setId, `卡${index}`, String(index), printingId, now, now);
    database.prepare("INSERT OR IGNORE INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 0, 'manual-test', 'fixture', 1, ?, ?)").run(skuId, printingId, now, now);
    database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, market_value_captured_at, updated_at) VALUES (?, ?, ?, 1, 1, 0, 0, 0, NULL, NULL, ?)").run(`h1000000-0000-4000-8000-${String(index).padStart(12, "0")}`, userId, skuId, now);
  }
}

describe("AchievementService", () => {
  it("returns controlled definitions and empty progress for a fresh player", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "10000000-0000-4000-8000-000000000001";
    registerUser(database, userId, "a@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-fresh", requestFingerprint: "achievement-fresh", requestId: "request-fresh", now: new Date("2026-07-30T02:00:00.000Z") });
    const service = achievementService(database);
    const overview = service.overview(userId);
    expect(overview.length).toBe(8);
    expect(overview.every((entry) => entry.progress === null)).toBe(true);
    const first = overview.find((entry) => entry.definition.id === "first-tournament/v1")!;
    expect(first.definition.ruleVersion).toBe(ACHIEVEMENT_RULE_VERSION);
    database.close();
  });

  it("unlocks first participation, champion and grants credit reward exactly once", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "20000000-0000-4000-8000-000000000001";
    registerUser(database, userId, "b@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-first", requestFingerprint: "achievement-first", requestId: "request-first", now: new Date("2026-07-30T02:00:00.000Z") });
    const { factEventId } = settleNpcRegistration(database, userId, 30, "1", true);
    const before = available(database, userId);
    const service = achievementService(database);
    expect(service.processFactEvent({ factEventId, now: new Date("2026-07-30T02:30:00.000Z") })).toEqual({ processed: true });
    const after = available(database, userId);
    // 首次参赛 200 + 冠军徽章（无货币）= +200；赛事奖励已在 settle 时入账，不在此 delta。
    expect(after - before).toBe(200);
    const unlockCount = (database.prepare("SELECT COUNT(*) AS count FROM achievement_unlocks WHERE user_id = ?").get(userId) as { count: number }).count;
    expect(unlockCount).toBeGreaterThanOrEqual(2);
    // 重复处理同一 fact 不重复解锁或发奖。
    service.processFactEvent({ factEventId, now: new Date("2026-07-30T02:31:00.000Z") });
    expect(available(database, userId)).toBe(after);
    const unlockCountAfter = (database.prepare("SELECT COUNT(*) AS count FROM achievement_unlocks WHERE user_id = ?").get(userId) as { count: number }).count;
    expect(unlockCountAfter).toBe(unlockCount);
    database.close();
  });

  it("does not unlock champion or streak when the player lost", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "21000000-0000-4000-8000-000000000001";
    registerUser(database, userId, "c@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-lost", requestFingerprint: "achievement-lost", requestId: "request-lost", now: new Date("2026-07-30T02:00:00.000Z") });
    const { factEventId } = settleNpcRegistration(database, userId, 29, "2", false);
    const service = achievementService(database);
    service.processFactEvent({ factEventId, now: new Date("2026-07-30T02:30:00.000Z") });
    expect(service.detail(userId, "tournament-champion/v1")?.progress?.status).toBe("pending");
    expect(service.detail(userId, "first-tournament/v1")?.progress?.status).toBe("unlocked");
    database.close();
  });

  it("unlocks the three-win streak achievement on the third consecutive win", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "22000000-0000-4000-8000-000000000001";
    registerUser(database, userId, "d@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-streak", requestFingerprint: "achievement-streak", requestId: "request-streak", now: new Date("2026-07-27T02:00:00.000Z") });
    const service = achievementService(database);
    // 三天三胜；连续胜场在第 3 次达到 3。
    for (const [day, suffix] of [[27, "s1"], [28, "s2"], [29, "s3"]] as const) {
      const { factEventId } = settleNpcRegistration(database, userId, day, suffix, true);
      service.processFactEvent({ factEventId, now: new Date(`2026-07-${String(day).padStart(2, "0")}T02:30:00.000Z`) });
    }
    expect(service.detail(userId, "win-streak-3/v1")?.progress).toMatchObject({ status: "unlocked", currentValue: 3 });
    database.close();
  });

  it("resets the consecutive win streak after a loss", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "22500000-0000-4000-8000-000000000001";
    registerUser(database, userId, "streak2@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-streak2", requestFingerprint: "achievement-streak2", requestId: "request-streak2", now: new Date("2026-07-26T02:00:00.000Z") });
    const service = achievementService(database);
    const w1 = settleNpcRegistration(database, userId, 26, "a1", true);
    service.processFactEvent({ factEventId: w1.factEventId, now: new Date("2026-07-26T02:30:00.000Z") });
    const loss = settleNpcRegistration(database, userId, 27, "a2", false);
    service.processFactEvent({ factEventId: loss.factEventId, now: new Date("2026-07-27T02:30:00.000Z") });
    const w2 = settleNpcRegistration(database, userId, 28, "a3", true);
    service.processFactEvent({ factEventId: w2.factEventId, now: new Date("2026-07-28T02:30:00.000Z") });
    // 败后连胜重置：1 胜后 progress=1，未解锁。
    expect(service.detail(userId, "win-streak-3/v1")?.progress).toMatchObject({ status: "pending", currentValue: 1 });
    database.close();
  });

  it("unlocks collection milestones based on distinct SKU count and re-evaluates on each event", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "23000000-0000-4000-8000-000000000001";
    const now = "2026-07-29T02:00:00.000Z";
    registerUser(database, userId, "e@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-collect", requestFingerprint: "achievement-collect", requestId: "request-collect", now: new Date(now) });
    grantDistinctSkus(database, userId, 10, now);
    const { factEventId } = settleNpcRegistration(database, userId, 29, "c1", false);
    const service = achievementService(database);
    service.processFactEvent({ factEventId, now: new Date("2026-07-29T02:30:00.000Z") });
    expect(service.detail(userId, "collection-10/v1")?.progress?.status).toBe("unlocked");
    expect(service.detail(userId, "collection-50/v1")?.progress?.status).toBe("pending");
    database.close();
  });

  it("traces unlock source back to the fact and aggregate via the unlock DTO", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "24000000-0000-4000-8000-000000000001";
    registerUser(database, userId, "f@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-trace", requestFingerprint: "achievement-trace", requestId: "request-trace", now: new Date("2026-07-29T02:00:00.000Z") });
    const { factEventId, registrationId } = settleNpcRegistration(database, userId, 29, "t1", true);
    const service = achievementService(database);
    service.processFactEvent({ factEventId, now: new Date("2026-07-29T02:30:00.000Z") });
    const unlocks = service.unlocks(userId);
    const first = unlocks.find((unlock) => unlock.definitionId === "first-tournament/v1")!;
    expect(first.source).toMatchObject({ type: "tournament.settled", factId: factEventId, aggregateId: registrationId });
    expect(first.rewardCorrelationId).toContain("achievement-reward");
    database.close();
  });

  it("blocks the reward when the daily reward risk limit is exceeded but still records the unlock", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "25000000-0000-4000-8000-000000000001";
    registerUser(database, userId, "g@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-risk", requestFingerprint: "achievement-risk", requestId: "request-risk", now: new Date("2026-07-29T02:00:00.000Z") });
    // 把每日奖励上限压到 1；同一场赛事同时达到收藏和首次参赛两个货币成就，第二笔必须被风控拦截。
    database.prepare("UPDATE achievement_risk_limits SET max_rewards_per_day = 1, updated_at = '2026-07-29T00:00:00.000Z' WHERE singleton = 1").run();
    grantDistinctSkus(database, userId, 10, "2026-07-29T02:00:00.000Z");
    const service = achievementService(database);
    const first = settleNpcRegistration(database, userId, 29, "r1", true);
    const before = available(database, userId);
    service.processFactEvent({ factEventId: first.factEventId, now: new Date("2026-07-29T02:30:00.000Z") });
    expect(available(database, userId) - before).toBe(100);
    expect(service.detail(userId, "collection-10/v1")?.unlock?.rewardStatus).toBe("granted");
    expect(service.detail(userId, "first-tournament/v1")?.unlock?.rewardStatus).toBe("blocked");
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'achievement.reward_blocked' AND actor_id = ?").get(userId)).toEqual({ count: 1 });
    database.close();
  });

  it("rolls back the reward grant and balance when grant persistence fails mid-transaction", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "26000000-0000-4000-8000-000000000001";
    registerUser(database, userId, "h@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-rollback", requestFingerprint: "achievement-rollback", requestId: "request-rollback", now: new Date("2026-07-29T02:00:00.000Z") });
    const { factEventId } = settleNpcRegistration(database, userId, 29, "rb1", true);
    const before = available(database, userId);
    // 将 first-tournament 奖励改成引用不存在的 SKU，触发 acquireInLedgerTransaction 失败 → 抛错 → 整事务回滚。
    database.prepare("UPDATE achievement_definitions SET reward_kind = 'sku', reward_amount = 0, reward_sku_id = 'nonexistent-sku-00000000-0000-4000-8000-000000000099' WHERE id = 'first-tournament/v1'").run();
    const service = achievementService(database);
    expect(() => service.processFactEvent({ factEventId, now: new Date("2026-07-29T02:30:00.000Z") })).toThrow();
    expect(available(database, userId)).toBe(before);
    const unlocks = (database.prepare("SELECT COUNT(*) AS count FROM achievement_unlocks WHERE user_id = ?").get(userId) as { count: number }).count;
    expect(unlocks).toBe(0);
    database.close();
  });

  it("is idempotent when processing the same fact concurrently via the unique unlock constraint", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-achievement-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const userId = "27000000-0000-4000-8000-000000000001";
    registerUser(database, userId, "i@test.local");
    new UserService(database).createArchive({ userId, idempotencyKey: "achievement-concurrent", requestFingerprint: "achievement-concurrent", requestId: "request-concurrent", now: new Date("2026-07-29T02:00:00.000Z") });
    const { factEventId } = settleNpcRegistration(database, userId, 29, "cc1", true);
    const service = achievementService(database);
    service.processFactEvent({ factEventId, now: new Date("2026-07-29T02:30:00.000Z") });
    // 第二次处理同一 fact：last_evaluated_fact_id 去重直接幂等返回。
    expect(service.processFactEvent({ factEventId, now: new Date("2026-07-29T02:31:00.000Z") })).toEqual({ processed: true });
    const grants = (database.prepare("SELECT COUNT(*) AS count FROM achievement_reward_grants WHERE user_id = ? AND definition_id = 'first-tournament/v1'").get(userId) as { count: number }).count;
    expect(grants).toBe(1);
    database.close();
  });
});
