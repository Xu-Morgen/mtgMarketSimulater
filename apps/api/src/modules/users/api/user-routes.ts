import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey } from "@mtg-market/contracts";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { archiveRequestFingerprint, UserService } from "../application/user-service.js";

const archiveBodySchema = z.object({}).strict();
const ledgerQuerySchema = z.object({ cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

/** users API 仅负责认证、协议映射与幂等键提取，经济写入均委派给 application。 */
export async function registerUserRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const users = new UserService(database);
  app.post("/v1/archive", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = archiveBodySchema.parse(request.body ?? {});
    const result = users.createArchive({ userId: request.actor!.id, idempotencyKey: key, requestFingerprint: archiveRequestFingerprint(body), requestId: request.requestId });
    if (result.state === "conflict") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
    if (result.state === "in-progress") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
    if (result.state === "replayed") return reply.code(200).send(result.response);
    return reply.code(201).send(result.response);
  });

  app.get("/v1/archive", { preHandler: requireRole("player") }, async (request, reply) => {
    const archive = users.archive(request.actor!.id);
    return archive ? success(request.requestId, { archive }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "尚未创建游戏存档"));
  });
  app.get("/v1/account", { preHandler: requireRole("player") }, async (request, reply) => {
    const balance = users.balance(request.actor!.id);
    return balance ? success(request.requestId, { balance }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "尚未创建资金账户"));
  });
  app.get("/v1/ledger", { preHandler: requireRole("player") }, async (request) => {
    const query = ledgerQuerySchema.parse(request.query);
    return success(request.requestId, users.ledger(request.actor!.id, query.cursor, query.limit));
  });
}
