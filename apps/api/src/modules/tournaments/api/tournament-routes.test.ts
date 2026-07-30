import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../../app.js";
import { loadApiConfig } from "../../../config/environment.js";

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
  it("requires idempotency, replays player-event creation and protects participant-only reads", async () => {
    const { app, database } = await fixture();
    const owner = await player(app, "owner"); const outsider = await player(app, "outsider");
    const body = { mode: "tabletop", name: "周末 Commander" };
    const missing = await app.inject({ method: "POST", url: "/v1/player-tournaments", headers: { authorization: owner }, payload: body });
    const first = await app.inject({ method: "POST", url: "/v1/player-tournaments", headers: { authorization: owner, "idempotency-key": "player-tournament-create-0001" }, payload: body });
    const replay = await app.inject({ method: "POST", url: "/v1/player-tournaments", headers: { authorization: owner, "idempotency-key": "player-tournament-create-0001" }, payload: body });
    const tournamentId = first.json().data.tournamentId as string;
    const ownerRounds = await app.inject({ method: "GET", url: `/v1/player-tournaments/${tournamentId}/rounds`, headers: { authorization: owner } });
    const hidden = await app.inject({ method: "GET", url: `/v1/player-tournaments/${tournamentId}`, headers: { authorization: outsider } });
    const replayDenied = await app.inject({ method: "GET", url: `/v1/admin/player-tournaments/${tournamentId}/replay`, headers: { authorization: owner } });

    expect(missing).toMatchObject({ statusCode: 400 }); expect(missing.json()).toMatchObject({ error: { code: "IDEMPOTENCY_KEY_REQUIRED" } });
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(200); expect(replay.json().data.tournamentId).toBe(tournamentId);
    expect(ownerRounds.json()).toMatchObject({ ok: true, data: { items: [] } });
    expect(hidden.statusCode).toBe(404); expect(replayDenied.statusCode).toBe(403);
    expect(database.prepare("SELECT COUNT(*) AS count FROM player_tournaments").get()).toEqual({ count: 1 });
    await app.close(); database.close();
  });
});
