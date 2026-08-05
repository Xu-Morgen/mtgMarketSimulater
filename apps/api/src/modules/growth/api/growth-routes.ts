import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey } from "@mtg-market/contracts";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { LevelService } from "../application/level-service.js";
import { taskClaimRequestFingerprint, TaskService } from "../application/task-service.js";

const claimParamsSchema = z.object({ instanceId: z.string().uuid() }).strict();

function hasArchive(database: Database.Database, userId: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM accounts WHERE user_id = ?").get(userId));
}

/**
 * I35B：任务中心与等级/声望只读/领取路由。任务进度与等级由服务端基于已结算事实推进；
 * 领取为显式命令（幂等键 + 状态机），浏览器不得判定完成、统计进度或计算经验。
 */
export async function registerGrowthRoutes(app: FastifyInstance, database: Database.Database, timezone: string): Promise<void> {
  const tasks = new TaskService(database, timezone);
  const levels = new LevelService(database);

  app.get("/v1/tasks", { preHandler: requireRole("player") }, async (request, reply) => {
    if (!hasArchive(database, request.actor!.id))
      return reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", "请先创建游戏存档"));
    return success(request.requestId, tasks.overview(request.actor!.id));
  });

  app.post("/v1/tasks/:instanceId/claim", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key))
      return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    if (!hasArchive(database, request.actor!.id))
      return reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", "请先创建游戏存档"));
    const params = claimParamsSchema.parse(request.params);
    const result = tasks.claim({
      userId: request.actor!.id,
      instanceId: params.instanceId,
      idempotencyKey: key,
      requestFingerprint: taskClaimRequestFingerprint(params),
      requestId: request.requestId
    });
    if (result.state === "conflict")
      return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
    if (result.state === "in-progress")
      return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
    return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
  });

  app.get("/v1/growth", { preHandler: requireRole("player") }, async (request, reply) => {
    if (!hasArchive(database, request.actor!.id))
      return reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", "请先创建游戏存档"));
    return success(request.requestId, levels.profile(request.actor!.id));
  });
}
