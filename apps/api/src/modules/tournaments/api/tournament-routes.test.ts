import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";
import { DeckService } from "../../decks/application/deck-service.js";
import { UserService } from "../../users/application/user-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-api-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const app = await createApiApp(loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters" }), database);
  return { app, database };
}

async function player(app: Awaited<ReturnType<typeof fixture>>["app"], suffix: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email: `tournament-${suffix}@example.test`, displayName: `赛事玩家${suffix}`, password: "correct-horse-battery-staple" } });
  return `Bearer ${response.json().data.accessToken as string}`;
}

describe("tournament HTTP boundary", () => {
  it("以 503 和脱敏分类暴露 Leyline 评分网络失败，不创建报名或库存锁定", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-tournament-api-")); directories.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    const app = await createApiApp(loadApiConfig({ APP_ENV: "test", SQLITE_PATH: join(directory, "test.db"), AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters", LEYLINE_ENDPOINT: "http://127.0.0.1:1/evaluate", LEYLINE_MAX_RETRIES: "0" }), database);
    const authorization = await player(app, "scoring-failure");
    const user = database.prepare("SELECT id FROM users WHERE email = ?").get("tournament-scoring-failure@example.test") as { id: string };
    const now = new Date(); const iso = now.toISOString();
    new UserService(database).createArchive({ userId: user.id, idempotencyKey: "scoring-failure-archive-0001", requestFingerprint: "scoring-failure-archive-0001", requestId: "scoring-failure-archive-0001", now });
    const setId = "11000000-0000-4000-8000-000000000001"; const printingId = "21000000-0000-4000-8000-000000000001"; const skuId = "31000000-0000-4000-8000-000000000001";
    database.prepare("INSERT INTO card_sets (id, code, name, source, created_at) VALUES (?, 'API', '接口赛事', 'manual-test', ?)").run(setId, iso);
    database.prepare("INSERT INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_id, oracle_text, rarity, legalities_json, color_identity_json, type_line, keywords_json, mana_value, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, '接口统帅', '1', NULL, 'api-commander', '', 'rare', '{\"commander\":\"legal\"}', '[\"R\"]', 'Legendary Creature — Human', '[]', 3, 'manual-test', 'fixture', 1, ?, ?)").run(printingId, setId, iso, iso);
    database.prepare("INSERT INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, 'nonfoil', 0, 'manual-test', 'fixture', 1, ?, ?)").run(skuId, printingId, iso, iso);
    database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, market_value_captured_at, updated_at) VALUES (?, ?, ?, 1, 1, 0, 0, 0, NULL, NULL, ?)").run("api-scoring-holding-001", user.id, skuId, iso);
    const deck = new DeckService(database).create({ userId: user.id, name: "接口评分失败卡组", cards: [{ zone: "commander", skuId, quantity: 1 }, { zone: "virtual_basic", virtualBasic: "mountain", quantity: 99 }], idempotencyKey: "scoring-failure-deck-0001", requestId: "scoring-failure-deck-0001" });
    if (!deck.response.ok) throw new Error("接口评分失败夹具未创建卡组");
    const tournaments = await app.inject({ method: "GET", url: "/v1/tournaments", headers: { authorization } });
    const tournamentId = tournaments.json().data.items[0].id as string;
    const response = await app.inject({ method: "POST", url: `/v1/tournaments/${tournamentId}/register`, headers: { authorization, "idempotency-key": "scoring-failure-register-0001" }, payload: { deckId: deck.response.data.id } });
    expect(response).toMatchObject({ statusCode: 503 });
    expect(response.json()).toMatchObject({ ok: false, error: { code: "SCORING_UNAVAILABLE", message: "卡组评分服务网络连接失败，请稍后重试", details: { provider: "leyline", failureReason: "network", attempts: 1 } } });
    expect(database.prepare("SELECT COUNT(*) AS count FROM tournament_registrations").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT tournament_locked_quantity FROM inventory_holdings WHERE id = 'api-scoring-holding-001'").get()).toEqual({ tournament_locked_quantity: 0 });
    await app.close(); database.close();
  });

  it("requires idempotency, replays player-event creation and protects participant-only reads", async () => {
    const { app, database } = await fixture();
    const owner = await player(app, "owner"); const outsider = await player(app, "outsider");
    const body = { mode: "tabletop", name: "周末 Commander" };
    const missing = await app.inject({ method: "POST", url: "/v1/player-tournaments", headers: { authorization: owner }, payload: body });
    const first = await app.inject({ method: "POST", url: "/v1/player-tournaments", headers: { authorization: owner, "idempotency-key": "player-tournament-create-0001" }, payload: body });
    const replay = await app.inject({ method: "POST", url: "/v1/player-tournaments", headers: { authorization: owner, "idempotency-key": "player-tournament-create-0001" }, payload: body });
    const tournamentId = first.json().data.tournamentId as string;
    const playerList = await app.inject({ method: "GET", url: "/v1/player-tournaments", headers: { authorization: owner } });
    const npcHistory = await app.inject({ method: "GET", url: "/v1/tournaments/history", headers: { authorization: owner } });
    const ownerRounds = await app.inject({ method: "GET", url: `/v1/player-tournaments/${tournamentId}/rounds`, headers: { authorization: owner } });
    const hidden = await app.inject({ method: "GET", url: `/v1/player-tournaments/${tournamentId}`, headers: { authorization: outsider } });
    const replayDenied = await app.inject({ method: "GET", url: `/v1/admin/player-tournaments/${tournamentId}/replay`, headers: { authorization: owner } });

    expect(missing).toMatchObject({ statusCode: 400 }); expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(200); expect(replay.json().data.tournamentId).toBe(tournamentId);
    expect(playerList.json()).toMatchObject({ ok: true, data: { items: [expect.objectContaining({ id: tournamentId, name: "周末 Commander" })] } });
    expect(npcHistory.json()).toMatchObject({ ok: true, data: { items: [] } });
    expect(ownerRounds.json()).toMatchObject({ ok: true, data: { items: [] } });
    expect(hidden.statusCode).toBe(404); expect(replayDenied.statusCode).toBe(403);
    expect(database.prepare("SELECT COUNT(*) AS count FROM player_tournaments").get()).toEqual({ count: 1 });
    await app.close(); database.close();
  });
});
