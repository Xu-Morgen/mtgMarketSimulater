import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { isValidIdempotencyKey } from "@mtg-market/contracts";
import { z } from "zod";
import type { ApiConfig } from "../../../config/environment.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { LeylineClient } from "../../decks/infrastructure/leyline-client.js";
import { type TournamentLogger, TournamentService } from "../application/tournament-service.js";

const tournamentIdParams = z.object({ tournamentId: z.string().uuid() }).strict();
const roundIdParams = z.object({ roundId: z.string().uuid() }).strict();
const disputeIdParams = z.object({ disputeId: z.string().uuid() }).strict();
const grantIdParams = z.object({ grantId: z.string().uuid() }).strict();
const registerBody = z.object({ deckId: z.string().uuid() }).strict();
const settleBody = z.object({ registrationId: z.string().uuid() }).strict();
const playerTournamentBody = z.object({ mode: z.enum(["game", "tabletop"]), name: z.string().trim().min(1).max(100) }).strict();
const joinBody = z.union([
  z.object({ deckName: z.string().trim().min(1).max(100) }).strict(),
  z.object({ deckId: z.string().uuid() }).strict()
]);
const roundBody = z.object({ winnerRegistrationId: z.string().uuid().nullable(), draw: z.boolean(), forfeitedRegistrationIds: z.array(z.string().uuid()).max(8) }).strict();
const disputeBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
const resolveDisputeBody = z.object({ reason: z.string().trim().min(1).max(500), awardedPoints: z.array(z.object({ registrationId: z.string().uuid(), points: z.number().int().min(0).max(4) }).strict()).min(1).max(8) }).strict();

type CommandResult<T> =
  | { state: "completed" | "replayed"; data: T }
  | { state: "conflict" | "in-progress" };

function idempotencyKey(request: { headers: Record<string, unknown> }): string | null {
  const key = request.headers["idempotency-key"];
  return typeof key === "string" && isValidIdempotencyKey(key) ? key : null;
}

function commandFailure<T>(requestId: string, command: CommandResult<T>) {
  return failure(requestId, command.state === "conflict" ? "IDEMPOTENCY_CONFLICT" : "IDEMPOTENCY_IN_PROGRESS", command.state === "conflict" ? "Idempotency-Key 已用于不同请求" : "相同请求正在处理中");
}

function statusFor(result: string): number {
  return result === "not-found" ? 404 : result === "forbidden" ? 403 : result === "score-unavailable" ? 503 : 409;
}

function codeFor(result: string) {
  return result === "not-found" ? "RESOURCE_NOT_FOUND" : result === "forbidden" ? "AUTHORIZATION_DENIED" : result === "invalid-deck" ? "RULE_VIOLATION" : result === "score-unavailable" ? "SCORING_UNAVAILABLE" : result === "idempotency-conflict" ? "IDEMPOTENCY_CONFLICT" : result === "in-progress" ? "IDEMPOTENCY_IN_PROGRESS" : "RESOURCE_CONFLICT" as const;
}

function requireKey(request: { headers: Record<string, unknown> }): string | null {
  return idempotencyKey(request);
}

export function createTournamentService(database: Database.Database, config: Pick<ApiConfig, "APP_TIMEZONE" | "DECK_RESPONSE_ENCRYPTION_KEY" | "LEYLINE_ENDPOINT" | "LEYLINE_TIMEOUT_MS" | "LEYLINE_MAX_RETRIES">, logger?: TournamentLogger): TournamentService {
  return new TournamentService(database, {
    timezone: config.APP_TIMEZONE,
    encryptionKey: config.DECK_RESPONSE_ENCRYPTION_KEY,
    leyline: new LeylineClient({ endpoint: config.LEYLINE_ENDPOINT, timeoutMs: config.LEYLINE_TIMEOUT_MS, maxRetries: config.LEYLINE_MAX_RETRIES }),
    ...(logger ? { logger } : {})
  });
}

/** HTTP 只负责验证、鉴权、幂等键与语义映射；所有 SQL、锁定和规则均在 application。 */
export async function registerTournamentRoutes(app: FastifyInstance, database: Database.Database, config: Pick<ApiConfig, "APP_TIMEZONE" | "DECK_RESPONSE_ENCRYPTION_KEY" | "LEYLINE_ENDPOINT" | "LEYLINE_TIMEOUT_MS" | "LEYLINE_MAX_RETRIES">): Promise<void> {
  const tournaments = createTournamentService(database, config, app.log);

  app.get("/v1/tournaments", { preHandler: requireRole("player") }, async (request) => success(request.requestId, { items: tournaments.list(request.actor!.id) }));
  app.get("/v1/tournaments/history", { preHandler: requireRole("player") }, async (request) => success(request.requestId, { items: tournaments.history(request.actor!.id) }));
  app.get("/v1/tournaments/:tournamentId/registration", { preHandler: requireRole("player") }, async (request, reply) => {
    const registration = tournaments.registration(request.actor!.id, tournamentIdParams.parse(request.params).tournamentId);
    return registration ? success(request.requestId, { registration }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "尚未报名该赛事"));
  });
  app.get("/v1/tournaments/:tournamentId/result", { preHandler: requireRole("player") }, async (request, reply) => {
    const result = tournaments.settlement(request.actor!.id, tournamentIdParams.parse(request.params).tournamentId);
    return result ? success(request.requestId, { result }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "赛事尚未结算"));
  });
  app.get("/v1/tournament-pack-grants", { preHandler: requireRole("player") }, async (request) =>
    success(request.requestId, { items: tournaments.availablePackGrants(request.actor!.id) })
  );
  app.post("/v1/tournament-pack-grants/:grantId/claim", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const result = tournaments.claimTournamentPack({ userId: request.actor!.id, grantId: grantIdParams.parse(request.params).grantId, idempotencyKey: key, requestId: request.requestId });
    return reply.code(result.statusCode).send(result.response);
  });
  app.get("/v1/player-tournament-pack-grants", { preHandler: requireRole("player") }, async (request) =>
    success(request.requestId, { items: tournaments.availablePlayerTournamentPackGrants(request.actor!.id) })
  );
  app.post("/v1/player-tournament-pack-grants/:grantId/claim", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const result = tournaments.claimPlayerTournamentPack({ userId: request.actor!.id, grantId: grantIdParams.parse(request.params).grantId, idempotencyKey: key, requestId: request.requestId });
    return reply.code(result.statusCode).send(result.response);
  });
  app.post("/v1/tournaments/:tournamentId/register", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const result = await tournaments.register({ userId: request.actor!.id, tournamentId: tournamentIdParams.parse(request.params).tournamentId, deckId: registerBody.parse(request.body).deckId, idempotencyKey: key, requestId: request.requestId });
    return reply.code(result.statusCode).send(result.response);
  });
  app.post("/v1/admin/tournaments/settle", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = settleBody.parse(request.body);
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "admin-npc-settle", ...body }, operation: () => tournaments.settleRegistration(body.registrationId) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return command.data ? success(request.requestId, { result: command.data }) : reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", "报名尚不可结算或不存在"));
  });

  app.post("/v1/player-tournaments", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = playerTournamentBody.parse(request.body);
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "player-tournament-create", ...body }, operation: () => tournaments.createPlayerTournament({ creatorUserId: request.actor!.id, mode: body.mode, name: body.name, requestId: request.requestId }) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return reply.code(command.state === "completed" ? 201 : 200).send(success(request.requestId, { tournamentId: command.data }));
  });
  app.get("/v1/player-tournaments", { preHandler: requireRole("player") }, async (request) => success(request.requestId, { items: tournaments.playerTournamentList(request.actor!.id) }));
  app.get("/v1/player-tournaments/:tournamentId", { preHandler: requireRole("player") }, async (request, reply) => {
    const tournament = tournaments.playerTournament(request.actor!.id, tournamentIdParams.parse(request.params).tournamentId);
    return tournament ? success(request.requestId, { tournament }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "赛事不存在或当前玩家无权读取"));
  });
  app.get("/v1/player-tournaments/:tournamentId/registrations", { preHandler: requireRole("player") }, async (request, reply) => {
    const items = tournaments.playerRegistrations(request.actor!.id, tournamentIdParams.parse(request.params).tournamentId);
    return items ? success(request.requestId, { items }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "赛事不存在或当前玩家无权读取"));
  });
  app.get("/v1/player-tournaments/:tournamentId/rounds", { preHandler: requireRole("player") }, async (request, reply) => {
    const items = tournaments.playerRounds(request.actor!.id, tournamentIdParams.parse(request.params).tournamentId);
    return items ? success(request.requestId, { items }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "赛事不存在或当前玩家无权读取"));
  });
  app.get("/v1/player-tournaments/:tournamentId/result", { preHandler: requireRole("player") }, async (request, reply) => {
    const result = tournaments.playerResult(request.actor!.id, tournamentIdParams.parse(request.params).tournamentId);
    return result ? success(request.requestId, { result }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "当前玩家尚无赛事结果"));
  });
  app.get("/v1/admin/player-tournaments/:tournamentId/replay", { preHandler: requireRole("admin") }, async (request, reply) => {
    const replay = tournaments.playerTournamentReplayForAdmin(tournamentIdParams.parse(request.params).tournamentId);
    return replay ? success(request.requestId, { replay }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "赛事不存在"));
  });

  app.post("/v1/player-tournaments/:tournamentId/join", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const tournamentId = tournamentIdParams.parse(request.params).tournamentId;
    const body = joinBody.parse(request.body);
    if ("deckId" in body) {
      const result = await tournaments.joinGameTournament({ userId: request.actor!.id, tournamentId, deckId: body.deckId, idempotencyKey: key, requestId: request.requestId });
      const failureResults = ["not-found", "closed", "invalid-mode", "duplicate", "invalid-deck", "score-unavailable", "idempotency-conflict", "in-progress"];
      return typeof result === "string" && !failureResults.includes(result)
        ? reply.code(201).send(success(request.requestId, { registrationId: result }))
        : reply.code(statusFor(result)).send(failure(request.requestId, codeFor(result), "赛事不可报名或卡组评分不可用"));
    }
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "tabletop-join", tournamentId, ...body }, operation: () => tournaments.joinPlayerTournament({ userId: request.actor!.id, tournamentId, deckName: body.deckName, requestId: request.requestId }) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    const result = command.data;
    return !["not-found", "closed", "invalid-mode", "duplicate", "missing-archive"].includes(result)
      ? reply.code(command.state === "completed" ? 201 : 200).send(success(request.requestId, { registrationId: result }))
      : reply.code(statusFor(result)).send(failure(request.requestId, codeFor(result), "赛事不可报名"));
  });
  app.post("/v1/player-tournaments/:tournamentId/withdraw", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const tournamentId = tournamentIdParams.parse(request.params).tournamentId;
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "withdraw", tournamentId }, operation: () => tournaments.withdrawPlayerTournament({ userId: request.actor!.id, tournamentId, requestId: request.requestId }) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return command.data === "ok" ? success(request.requestId, { status: "withdrawn" }) : reply.code(statusFor(command.data)).send(failure(request.requestId, codeFor(command.data), "无法退出赛事"));
  });
  app.post("/v1/player-tournaments/:tournamentId/start", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const tournamentId = tournamentIdParams.parse(request.params).tournamentId;
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "game-start", tournamentId }, operation: () => tournaments.startGameTournament({ actorUserId: request.actor!.id, tournamentId, requestId: request.requestId }) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return command.data === "queued" ? reply.code(command.state === "completed" ? 202 : 200).send(success(request.requestId, { status: "queued" })) : reply.code(statusFor(command.data)).send(failure(request.requestId, codeFor(command.data), "赛事不可开始"));
  });
  app.post("/v1/player-tournaments/:tournamentId/rounds", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const tournamentId = tournamentIdParams.parse(request.params).tournamentId;
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "tabletop-pair", tournamentId }, operation: () => tournaments.pairTabletopRound({ actorUserId: request.actor!.id, tournamentId, requestId: request.requestId }) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return Array.isArray(command.data) ? reply.code(command.state === "completed" ? 201 : 200).send(success(request.requestId, { roundIds: command.data })) : reply.code(statusFor(command.data)).send(failure(request.requestId, codeFor(command.data), "不能生成本轮配对"));
  });
  app.post("/v1/player-tournaments/:tournamentId/settle", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const tournamentId = tournamentIdParams.parse(request.params).tournamentId;
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "player-settle", tournamentId }, operation: () => {
      const tournament = tournaments.playerTournament(request.actor!.id, tournamentId);
      return tournament?.mode === "game" ? tournaments.settleGameTournament({ actorUserId: request.actor!.id, tournamentId, requestId: request.requestId }) : tournaments.settleTabletopTournament({ actorUserId: request.actor!.id, tournamentId, requestId: request.requestId });
    } });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return command.data === "ok" || command.data === "queued" ? reply.code(command.data === "queued" && command.state === "completed" ? 202 : 200).send(success(request.requestId, { status: command.data === "queued" ? "queued" : "settled" })) : reply.code(statusFor(command.data)).send(failure(request.requestId, codeFor(command.data), "赛事不可结算"));
  });

  app.post("/v1/player-tournament-rounds/:roundId/result", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const roundId = roundIdParams.parse(request.params).roundId;
    const body = roundBody.parse(request.body);
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "round-result", roundId, ...body }, operation: () => tournaments.submitTabletopResult({ userId: request.actor!.id, roundId, ...body, requestId: request.requestId }) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return command.data === "ok" ? success(request.requestId, { status: "submitted" }) : reply.code(statusFor(command.data)).send(failure(request.requestId, codeFor(command.data), "赛果不可提交"));
  });
  app.post("/v1/player-tournament-rounds/:roundId/confirm", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const roundId = roundIdParams.parse(request.params).roundId;
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "round-confirm", roundId }, operation: () => tournaments.confirmTabletopResult({ userId: request.actor!.id, roundId, requestId: request.requestId }) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return command.data === "ok" ? success(request.requestId, { status: "confirmed_or_pending" }) : reply.code(statusFor(command.data)).send(failure(request.requestId, codeFor(command.data), "赛果不可确认"));
  });
  app.post("/v1/player-tournament-rounds/:roundId/disputes", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const roundId = roundIdParams.parse(request.params).roundId;
    const body = disputeBody.parse(request.body);
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "dispute-open", roundId, ...body }, operation: () => tournaments.openDispute({ userId: request.actor!.id, roundId, reason: body.reason, requestId: request.requestId }) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return !["not-found", "forbidden", "conflict"].includes(command.data) ? reply.code(command.state === "completed" ? 201 : 200).send(success(request.requestId, { disputeId: command.data })) : reply.code(statusFor(command.data)).send(failure(request.requestId, codeFor(command.data), "争议不可创建"));
  });
  app.post("/v1/admin/tournament-disputes/:disputeId/resolve", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = requireKey(request);
    if (!key) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const disputeId = disputeIdParams.parse(request.params).disputeId;
    const body = resolveDisputeBody.parse(request.body);
    const command = tournaments.executePlayerCommand({ actorId: request.actor!.id, idempotencyKey: key, body: { operation: "dispute-resolve", disputeId, ...body }, operation: () => tournaments.resolveDispute({ adminUserId: request.actor!.id, disputeId, awardedPoints: body.awardedPoints, reason: body.reason, requestId: request.requestId }) });
    if (!("data" in command)) return reply.code(409).send(commandFailure(request.requestId, command));
    return command.data === "ok" ? success(request.requestId, { status: "resolved" }) : reply.code(statusFor(command.data)).send(failure(request.requestId, codeFor(command.data), "争议不可结案"));
  });
}
