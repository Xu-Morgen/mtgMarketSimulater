import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import type { DeckDto } from "@mtg-market/contracts";
import { DeckService } from "../../decks/application/deck-service.js";
import { LeylineClient } from "../../decks/infrastructure/leyline-client.js";
import { UserService } from "../../users/application/user-service.js";
import { TournamentService } from "./tournament-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function serviceFor(database: ReturnType<typeof openSqliteDatabase>): TournamentService {
  return new TournamentService(database, { timezone: "Asia/Shanghai", encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", leyline: new LeylineClient({ endpoint: "https://example.test/evaluate", timeoutMs: 100, maxRetries: 0 }) });
}

function scoredServiceFor(database: ReturnType<typeof openSqliteDatabase>, score = 65): TournamentService {
  return new TournamentService(database, { timezone: "Asia/Shanghai", encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", leyline: new LeylineClient({ endpoint: "https://example.test/evaluate", timeoutMs: 100, maxRetries: 0 }, async () => new Response(JSON.stringify({ scores: { power: score } }), { status: 200 })) });
}

function insertDeck(database: ReturnType<typeof openSqliteDatabase>, userId: string, deckId: string, now: string): void {
  database.prepare("INSERT INTO decks (id, user_id, name, format, rule_version, banlist_version, legality_json, created_at, updated_at) VALUES (?, ?, '测试牌组', 'commander-100/v1', 'commander-deck/v1', 'commander-banlist/2026-02-09', ?, ?, ?)").run(deckId, userId, JSON.stringify({ valid: true, totalCards: 100, colorIdentity: [], issues: [], ruleVersion: "commander-deck/v1", banlistVersion: "commander-banlist/2026-02-09", checkedAt: now }), now, now);
}

function createArchive(database: ReturnType<typeof openSqliteDatabase>, userId: string, now: Date, suffix: string): void {
  new UserService(database).createArchive({ userId, idempotencyKey: `tournament-archive-${suffix}`, requestFingerprint: `tournament-archive-${suffix}`, requestId: `request-archive-${suffix}`, now });
}

function createLegalDeck(database: ReturnType<typeof openSqliteDatabase>, userId: string, now: string): string {
  const setId = "12000000-0000-4000-8000-000000000001"; const printingId = "22000000-0000-4000-8000-000000000001"; const skuId = "32000000-0000-4000-8000-000000000001";
  database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'TRN', '赛事测试', 'manual-test', ?)").run(setId, now);
  database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_id, oracle_text, rarity, legalities_json, color_identity_json, type_line, keywords_json, mana_value, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '赛事统帅', '1', NULL, 'tournament-commander', '', 'rare', '{\"commander\":\"legal\"}', '[\"R\"]', 'Legendary Creature — Human', '[]', 3, 'manual-test', 'fixture', 1, ?, ?)").run(printingId, setId, now, now);
  database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 0, 'manual-test', 'fixture', 1, ?, ?)").run(skuId, printingId, now, now);
  database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, market_value_captured_at, updated_at) VALUES (?, ?, ?, 1, 1, 0, 0, 0, NULL, NULL, ?)").run("tournament-holding-001", userId, skuId, now);
  const saved = new DeckService(database).create({ userId, name: "赛事合法卡组", cards: [{ zone: "commander", skuId, quantity: 1 }, { zone: "virtual_basic", virtualBasic: "mountain", quantity: 99 }], idempotencyKey: "tournament-deck-create-0001", requestId: "request-deck-create-0001" });
  if (!saved.response.ok) throw new Error("赛事合法卡组夹具创建失败");
  return saved.response.data.id;
}

describe("TournamentService daily NPC instances", () => {
  it("creates exactly one isolated event per template, date and player", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const service = new TournamentService(database, { timezone: "Asia/Shanghai", encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", leyline: new LeylineClient({ endpoint: "https://example.test/evaluate", timeoutMs: 100, maxRetries: 0 }) });
    const now = new Date("2026-07-29T02:00:00.000Z");
    const userId = "00000000-0000-4000-8000-000000000005";
    expect(service.list(userId, now)).toHaveLength(3);
    expect(service.list(userId, now)).toHaveLength(3);
    expect(database.prepare("SELECT COUNT(*) AS count FROM tournaments WHERE owner_user_id = ?").get(userId)).toEqual({ count: 3 });
    const before = database.prepare("SELECT id, seed FROM tournaments WHERE owner_user_id = ? AND natural_date = '2026-07-29' ORDER BY id").all(userId);
    service.refreshDaily("2026-07-29", "Asia/Shanghai", now);
    expect(database.prepare("SELECT id, seed FROM tournaments WHERE owner_user_id = ? AND natural_date = '2026-07-29' ORDER BY id").all(userId)).toEqual(before);
    service.refreshDaily("2026-07-30", "Asia/Shanghai", new Date("2026-07-30T02:00:00.000Z"));
    expect(database.prepare("SELECT COUNT(*) AS count FROM tournaments WHERE owner_user_id = ?").get(userId)).toEqual({ count: 6 });
    database.close();
  });

  it("atomically registers a legal deck once, locks its commander and leaves no state after Leyline failure", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db")); const now = new Date("2026-07-29T02:00:00.000Z"); const userId = "00000000-0000-4000-8000-000000000005";
    createArchive(database, userId, now, "npc-register"); const deckId = createLegalDeck(database, userId, now.toISOString()); const service = scoredServiceFor(database);
    const daily = service.list(userId, now); const single = daily.find((event) => event.templateId === "daily-npc-single/v1")!;
    const scoringLogs: Array<Record<string, unknown>> = [];
    const unavailable = new TournamentService(database, { timezone: "Asia/Shanghai", encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", leyline: new LeylineClient({ endpoint: "https://example.test/evaluate", timeoutMs: 100, maxRetries: 0 }, async () => { throw new Error("timeout"); }), logger: { warn: (bindings) => scoringLogs.push(bindings) } });
    const swiss = daily.find((event) => event.templateId === "daily-npc-swiss/v1")!;
    const failed = await unavailable.register({ userId, tournamentId: swiss.id, deckId, idempotencyKey: "npc-register-key-0002", requestId: "request-register-0003", now });
    expect(failed).toMatchObject({ statusCode: 503, response: { ok: false, error: { code: "SCORING_UNAVAILABLE", message: "卡组评分请求超时，请稍后重试", details: { provider: "leyline", failureReason: "timeout", attempts: 1 } } } }); expect(scoringLogs).toEqual([expect.objectContaining({ event: "tournament.registration_scoring_failed", failureReason: "timeout", attempts: 1 })]); expect(database.prepare("SELECT COUNT(*) AS count FROM tournament_registrations WHERE tournament_id = ?").get(swiss.id)).toEqual({ count: 0 });
    const [first, replay] = await Promise.all([service.register({ userId, tournamentId: single.id, deckId, idempotencyKey: "npc-register-key-0001", requestId: "request-register-0001", now }), service.register({ userId, tournamentId: single.id, deckId, idempotencyKey: "npc-register-key-0001", requestId: "request-register-0002", now })]);
    if (!first.response.ok || !replay.response.ok) throw new Error("报名夹具未返回成功响应");
    const registrationId = first.response.data.registration.id;
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(201); expect(replay.response.data.registration.id).toBe(registrationId);
    expect(database.prepare("SELECT COUNT(*) AS count FROM tournament_registrations").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM tournament_deck_card_snapshots").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT tournament_locked_quantity FROM inventory_holdings WHERE user_id = ?").get(userId)).toEqual({ tournament_locked_quantity: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE unique_key = ?").get(`tournament-settle:registration:${registrationId}`)).toEqual({ count: 1 });
    database.close();
  });

  it("requires every tabletop player to confirm before fixed points are applied", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const service = new TournamentService(database, { timezone: "Asia/Shanghai", encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", leyline: new LeylineClient({ endpoint: "https://example.test/evaluate", timeoutMs: 100, maxRetries: 0 }) });
    const now = "2026-07-29T00:00:00.000Z";
    for (const [id, email] of [["10000000-0000-4000-8000-000000000001", "one@test.local"], ["10000000-0000-4000-8000-000000000002", "two@test.local"]] as const) database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'test', 'player', ?, ?)").run(id, email, email, now, now);
    const first = "10000000-0000-4000-8000-000000000001"; const second = "10000000-0000-4000-8000-000000000002";
    createArchive(database, first, new Date(now), "tabletop-one"); createArchive(database, second, new Date(now), "tabletop-two");
    const tournamentId = service.createPlayerTournament({ creatorUserId: first, mode: "tabletop", name: "现实桌", requestId: "request-0001", now: new Date(now) });
    const firstRegistration = service.joinPlayerTournament({ userId: first, tournamentId, deckName: "甲的卡组", requestId: "request-0002", now: new Date(now) }); const secondRegistration = service.joinPlayerTournament({ userId: second, tournamentId, deckName: "乙的卡组", requestId: "request-0003", now: new Date(now) });
    if (typeof firstRegistration !== "string" || typeof secondRegistration !== "string" || ["not-found", "closed", "duplicate"].includes(firstRegistration) || ["not-found", "closed", "duplicate"].includes(secondRegistration)) throw new Error("报名夹具失败");
    const [roundId] = service.pairTabletopRound({ actorUserId: first, tournamentId, requestId: "request-0004", now: new Date(now) }) as string[];
    expect(service.submitTabletopResult({ userId: first, roundId: roundId!, winnerRegistrationId: firstRegistration, draw: false, forfeitedRegistrationIds: [], requestId: "request-0005", now: new Date(now) })).toBe("ok");
    expect(service.confirmTabletopResult({ userId: first, roundId: roundId!, requestId: "request-0006", now: new Date(now) })).toBe("ok");
    expect(database.prepare("SELECT points FROM player_tournament_registrations WHERE id = ?").get(firstRegistration)).toEqual({ points: 0 });
    expect(service.confirmTabletopResult({ userId: second, roundId: roundId!, requestId: "request-0007", now: new Date(now) })).toBe("ok");
    expect(database.prepare("SELECT points FROM player_tournament_registrations WHERE id = ?").get(firstRegistration)).toEqual({ points: 4 });
    database.close();
  });

  it("creates a confirmed tabletop playoff only for a tied winner reward position", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db")); const service = serviceFor(database); const now = new Date("2026-07-29T00:00:00.000Z"); const iso = now.toISOString();
    const firstUser = "11000000-0000-4000-8000-000000000001"; const secondUser = "11000000-0000-4000-8000-000000000002";
    for (const [userId, email] of [[firstUser, "playoff-one@test.local"], [secondUser, "playoff-two@test.local"]] as const) { database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'test', 'player', ?, ?)").run(userId, email, email, iso, iso); createArchive(database, userId, now, userId.slice(-4)); }
    const tournamentId = service.createPlayerTournament({ creatorUserId: firstUser, mode: "tabletop", name: "奖励加赛", requestId: "request-playoff-0001", now });
    const first = service.joinPlayerTournament({ userId: firstUser, tournamentId, deckName: "甲", requestId: "request-playoff-0002", now }); const second = service.joinPlayerTournament({ userId: secondUser, tournamentId, deckName: "乙", requestId: "request-playoff-0003", now });
    if (typeof first !== "string" || typeof second !== "string" || ["not-found", "closed", "invalid-mode", "duplicate", "missing-archive"].includes(first) || ["not-found", "closed", "invalid-mode", "duplicate", "missing-archive"].includes(second)) throw new Error("报名夹具失败");
    const [normalRound] = service.pairTabletopRound({ actorUserId: firstUser, tournamentId, requestId: "request-playoff-0004", now }) as string[];
    expect(service.submitTabletopResult({ userId: firstUser, roundId: normalRound!, winnerRegistrationId: null, draw: true, forfeitedRegistrationIds: [], requestId: "request-playoff-0005", now })).toBe("ok");
    expect(service.confirmTabletopResult({ userId: firstUser, roundId: normalRound!, requestId: "request-playoff-0006", now })).toBe("ok"); expect(service.confirmTabletopResult({ userId: secondUser, roundId: normalRound!, requestId: "request-playoff-0007", now })).toBe("ok");
    expect(service.settleTabletopTournament({ actorUserId: firstUser, tournamentId, requestId: "request-playoff-0008", now })).toBe("conflict");
    const playoff = database.prepare("SELECT id, stage FROM player_tournament_rounds WHERE tournament_id = ? AND stage = 'playoff'").get(tournamentId) as { id: string; stage: string };
    expect(playoff.stage).toBe("playoff");
    expect(service.submitTabletopResult({ userId: firstUser, roundId: playoff.id, winnerRegistrationId: first, draw: false, forfeitedRegistrationIds: [], requestId: "request-playoff-0009", now })).toBe("ok");
    expect(service.confirmTabletopResult({ userId: firstUser, roundId: playoff.id, requestId: "request-playoff-0010", now })).toBe("ok"); expect(service.confirmTabletopResult({ userId: secondUser, roundId: playoff.id, requestId: "request-playoff-0011", now })).toBe("ok");
    expect(service.settleTabletopTournament({ actorUserId: firstUser, tournamentId, requestId: "request-playoff-0012", now })).toBe("ok");
    expect(database.prepare("SELECT reward_amount FROM player_tournament_results WHERE player_tournament_id = ? ORDER BY rank").all(tournamentId)).toEqual([{ reward_amount: 100 }, { reward_amount: 0 }]);
    database.close();
  });

  it("rejects a non-table player and lets an admin resolve a disputed table", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory); const database = openSqliteDatabase(join(directory, "test.db")); const service = new TournamentService(database, { timezone: "Asia/Shanghai", encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", leyline: new LeylineClient({ endpoint: "https://example.test/evaluate", timeoutMs: 100, maxRetries: 0 }) }); const now = new Date("2026-07-29T00:00:00.000Z");
    const users = ["10000000-0000-4000-8000-000000000021", "10000000-0000-4000-8000-000000000022", "10000000-0000-4000-8000-000000000023"]; for (const [index, userId] of users.entries()) { database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'test', 'player', ?, ?)").run(userId, `dispute-${index}@test.local`, `玩家${index}`, now.toISOString(), now.toISOString()); createArchive(database, userId, now, `dispute-${index}`); }
    const tournamentId = service.createPlayerTournament({ creatorUserId: users[0]!, mode: "tabletop", name: "争议桌", requestId: "request-0011", now }); const first = service.joinPlayerTournament({ userId: users[0]!, tournamentId, deckName: "甲", requestId: "request-0012", now }); const second = service.joinPlayerTournament({ userId: users[1]!, tournamentId, deckName: "乙", requestId: "request-0013", now }); if (typeof first !== "string" || typeof second !== "string" || ["not-found", "closed", "duplicate"].includes(first) || ["not-found", "closed", "duplicate"].includes(second)) throw new Error("报名夹具失败"); const [roundId] = service.pairTabletopRound({ actorUserId: users[0]!, tournamentId, requestId: "request-0014", now }) as string[]; expect(service.openDispute({ userId: users[2]!, roundId: roundId!, reason: "越权", requestId: "request-0015", now })).toBe("forbidden"); const disputeId = service.openDispute({ userId: users[0]!, roundId: roundId!, reason: "结果有争议", requestId: "request-0016", now }); if (typeof disputeId !== "string" || ["not-found", "forbidden", "conflict"].includes(disputeId)) throw new Error("争议夹具失败"); expect(service.resolveDispute({ adminUserId: "00000000-0000-4000-8000-000000000005", disputeId, awardedPoints: [{ registrationId: first, points: 1 }, { registrationId: second, points: 1 }], reason: "管理员确认平局", requestId: "request-0017", now })).toBe("ok"); expect(database.prepare("SELECT points FROM player_tournament_registrations WHERE id = ?").get(first)).toEqual({ points: 1 }); database.close();
  });

  it("persists player-command replay and rejects the same key with a changed payload", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db")); const service = new TournamentService(database, { timezone: "Asia/Shanghai", encryptionKey: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=", leyline: new LeylineClient({ endpoint: "https://example.test/evaluate", timeoutMs: 100, maxRetries: 0 }) }); const actorId = "00000000-0000-4000-8000-000000000005";
    const first = service.executePlayerCommand({ actorId, idempotencyKey: "player-command-key-0001", body: { value: 1 }, operation: () => "first" });
    const replay = service.executePlayerCommand({ actorId, idempotencyKey: "player-command-key-0001", body: { value: 1 }, operation: () => "second" });
    const conflict = service.executePlayerCommand({ actorId, idempotencyKey: "player-command-key-0001", body: { value: 2 }, operation: () => "third" });
    expect(first).toEqual({ state: "completed", data: "first" }); expect(replay).toEqual({ state: "replayed", data: "first" }); expect(conflict).toEqual({ state: "conflict" }); database.close();
  });

  it("stores game deck snapshots against the player-registration foreign key", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db")); const service = serviceFor(database); const now = "2026-07-29T00:00:00.000Z";
    const userId = "00000000-0000-4000-8000-000000000005"; const deckId = "21000000-0000-4000-8000-000000000001";
    const tournamentId = service.createPlayerTournament({ creatorUserId: userId, mode: "game", name: "快照外键", requestId: "request-snapshot-0001", now: new Date(now) });
    insertDeck(database, userId, deckId, now);
    const registrationId = "22000000-0000-4000-8000-000000000001";
    database.prepare("INSERT INTO player_tournament_registrations (id, tournament_id, user_id, deck_name, deck_id, power_snapshot_id, status, points, created_at) VALUES (?, ?, ?, '测试牌组', ?, NULL, 'registered', 0, ?)").run(registrationId, tournamentId, userId, deckId, now);
    const deck: DeckDto = { id: deckId, name: "测试牌组", format: "commander-100/v1", ruleVersion: "commander-deck/v1", banlistVersion: "commander-banlist/2026-02-09", cards: [], legality: { valid: true, totalCards: 100, colorIdentity: [], issues: [], ruleVersion: "commander-deck/v1", banlistVersion: "commander-banlist/2026-02-09", checkedAt: now }, strengthSnapshot: null, createdAt: now, updatedAt: now };
    new DeckService(database).savePlayerTournamentDeckSnapshotInTransaction({ registrationId, deck, now });
    expect(database.prepare("SELECT registration_id FROM player_tournament_deck_card_snapshots WHERE registration_id = ?").get(registrationId)).toEqual({ registration_id: registrationId });
    expect(database.pragma("foreign_key_check")).toEqual([]);
    database.close();
  });

  it("settles a personal NPC event once, releases holds and exposes its fixed-seed replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db")); const service = serviceFor(database);
    const now = new Date("2026-07-29T02:00:00.000Z"); const nowIso = now.toISOString();
    const userId = "00000000-0000-4000-8000-000000000005"; const deckId = "20000000-0000-4000-8000-000000000001";
    new UserService(database).createArchive({ userId, idempotencyKey: "tournament-test-archive-0001", requestFingerprint: "tournament-test-archive", requestId: "request-0101", now });
    const daily = service.list(userId, now); const tournament = daily.find((item) => item.templateId === "daily-npc-single/v1")!;
    insertDeck(database, userId, deckId, nowIso);
    const registrationId = "30000000-0000-4000-8000-000000000001"; const snapshotId = "40000000-0000-4000-8000-000000000001";
    database.prepare("INSERT INTO deck_power_snapshots (id, deck_id, registration_id, source, source_version, provider_algorithm_version, score, input_summary_sha256, computed_at, availability, degradation_reason, response_sha256, details_json, created_at) VALUES (?, ?, ?, 'leyline', 'leyline-adapter/v1', 'undeclared', 70, ?, ?, 'available', NULL, ?, '{}', ?)").run(snapshotId, deckId, registrationId, "a".repeat(64), nowIso, "b".repeat(64), nowIso);
    database.prepare("INSERT INTO tournament_registrations (id, tournament_id, user_id, deck_id, power_snapshot_id, status, entry_fee_amount, entry_fee_hold_id, registered_at, settled_at) VALUES (?, ?, ?, ?, ?, 'registered', 0, NULL, ?, NULL)").run(registrationId, tournament.id, userId, deckId, snapshotId, nowIso);
    const first = service.settleRegistration(registrationId, now); const replay = service.settleRegistration(registrationId, now);
    expect(replay).toEqual(first); expect(first?.replay.seed).toHaveLength(64); expect(first?.reward.amount).toBeGreaterThanOrEqual(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM tournament_results WHERE registration_id = ?").get(registrationId)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM fact_events WHERE aggregate_id = ? AND event_type = 'tournament.settled'").get(registrationId)).toEqual({ count: 1 });
    database.close();
  });

  it("queues and settles an in-game tournament exactly once from stored power snapshots", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db")); const service = serviceFor(database); const now = new Date("2026-07-29T00:00:00.000Z"); const nowIso = now.toISOString();
    const firstUser = "50000000-0000-4000-8000-000000000001"; const secondUser = "50000000-0000-4000-8000-000000000002";
    for (const [id, email] of [[firstUser, "game-one@test.local"], [secondUser, "game-two@test.local"]] as const) database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, 'test', 'player', ?, ?)").run(id, email, email, nowIso, nowIso);
    createArchive(database, firstUser, now, "game-one"); createArchive(database, secondUser, now, "game-two");
    const tournamentId = service.createPlayerTournament({ creatorUserId: firstUser, mode: "game", name: "游戏内", requestId: "request-0201", now });
    for (const [index, userId, score] of [[1, firstUser, 70], [2, secondUser, 40]] as const) {
      const deckId = `60000000-0000-4000-8000-00000000000${index}`; const registrationId = `70000000-0000-4000-8000-00000000000${index}`; const snapshotId = `80000000-0000-4000-8000-00000000000${index}`;
      insertDeck(database, userId, deckId, nowIso);
      database.prepare("INSERT INTO deck_power_snapshots (id, deck_id, registration_id, source, source_version, provider_algorithm_version, score, input_summary_sha256, computed_at, availability, degradation_reason, response_sha256, details_json, created_at) VALUES (?, ?, ?, 'leyline', 'leyline-adapter/v1', 'undeclared', ?, ?, ?, 'available', NULL, ?, '{}', ?)").run(snapshotId, deckId, registrationId, score, "c".repeat(64), nowIso, "d".repeat(64), nowIso);
      database.prepare("INSERT INTO player_tournament_registrations (id, tournament_id, user_id, deck_name, deck_id, power_snapshot_id, status, points, created_at) VALUES (?, ?, ?, '测试牌组', ?, ?, 'registered', 0, ?)").run(registrationId, tournamentId, userId, deckId, snapshotId, nowIso);
    }
    expect(service.startGameTournament({ actorUserId: firstUser, tournamentId, requestId: "request-0202", now })).toBe("queued");
    expect(service.settleScheduledGameTournament(tournamentId, now)).toBe(true); expect(service.settleScheduledGameTournament(tournamentId, now)).toBe(true);
    expect(database.prepare("SELECT COUNT(*) AS count FROM player_tournament_results WHERE player_tournament_id = ?").get(tournamentId)).toEqual({ count: 2 });
    expect(database.prepare("SELECT amount FROM player_tournament_rewards ORDER BY amount DESC").all()).toEqual([{ amount: 100 }]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM jobs WHERE type = 'tournament.settle' AND unique_key = ?").get(`tournament-settle:player:${tournamentId}`)).toEqual({ count: 1 });
    database.close();
  });

  it("rolls back a player reward draw, credit and result together when result persistence fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db")); const service = serviceFor(database); const now = new Date("2026-07-29T00:00:00.000Z"); const iso = now.toISOString();
    const userId = "51000000-0000-4000-8000-000000000001"; const deckId = "61000000-0000-4000-8000-000000000001"; const registrationId = "71000000-0000-4000-8000-000000000001"; const snapshotId = "81000000-0000-4000-8000-000000000001";
    database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, 'rollback@test.local', '回滚玩家', 'test', 'player', ?, ?)").run(userId, iso, iso); createArchive(database, userId, now, "reward-rollback");
    const tournamentId = service.createPlayerTournament({ creatorUserId: userId, mode: "game", name: "奖励回滚", requestId: "request-rollback-0001", now }); insertDeck(database, userId, deckId, iso);
    database.prepare("INSERT INTO deck_power_snapshots (id, deck_id, registration_id, source, source_version, provider_algorithm_version, score, input_summary_sha256, computed_at, availability, degradation_reason, response_sha256, details_json, created_at) VALUES (?, ?, ?, 'leyline', 'leyline-adapter/v1', 'undeclared', 60, ?, ?, 'available', NULL, ?, '{}', ?)").run(snapshotId, deckId, registrationId, "e".repeat(64), iso, "f".repeat(64), iso);
    database.prepare("INSERT INTO player_tournament_registrations (id, tournament_id, user_id, deck_name, deck_id, power_snapshot_id, status, points, created_at) VALUES (?, ?, ?, '测试牌组', ?, ?, 'registered', 0, ?)").run(registrationId, tournamentId, userId, deckId, snapshotId, iso);
    expect(service.startGameTournament({ actorUserId: userId, tournamentId, requestId: "request-rollback-0002", now })).toBe("queued");
    database.exec("CREATE TRIGGER fail_player_tournament_result BEFORE INSERT ON player_tournament_results BEGIN SELECT RAISE(ABORT, 'forced player result failure'); END;");
    expect(() => service.settleScheduledGameTournament(tournamentId, now)).toThrow("forced player result failure");
    expect(database.prepare("SELECT COUNT(*) AS count FROM player_tournament_reward_draws").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM player_tournament_rewards").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM player_tournament_results").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM ledger_entries WHERE reason = 'tournament_reward'").get()).toEqual({ count: 0 });
    database.close();
  });

});
