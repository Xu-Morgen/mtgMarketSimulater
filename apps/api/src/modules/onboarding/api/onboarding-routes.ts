import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey } from "@mtg-market/contracts";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { onboardingCommandRequestFingerprint, OnboardingService, type OnboardingCommandResult } from "../application/onboarding-service.js";

const stepParamsSchema = z.object({ stepId: z.string().min(1).max(80) }).strict();
const viewBodySchema = z.object({ path: z.string().min(1).max(200) }).strict();
const emptyBodySchema = z.object({}).strict();

function hasArchive(database: Database.Database, userId: string): boolean {
  return Boolean(database.prepare("SELECT 1 FROM accounts WHERE user_id = ?").get(userId));
}

/**
 * I36B：新手引导路由。步骤进度与完成奖励只由服务端基于已结算事实/状态推进；
 * 跳过与查看价格历史为浏览器提交的引导意图（幂等键 + 服务端校验），领取奖励为显式命令。
 * 引导页为未创建存档的新玩家开放只读查询与意图提交，领取完成奖励要求存档（入账需要资金账户）。
 */
export async function registerOnboardingRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const onboarding = new OnboardingService(database);

  app.get("/v1/onboarding", { preHandler: requireRole("player") }, async (request) => {
    return success(request.requestId, { onboarding: onboarding.overview(request.actor!.id) });
  });

  app.post("/v1/onboarding/steps/:stepId/skip", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key))
      return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const params = stepParamsSchema.parse(request.params);
    const result = onboarding.skip({
      userId: request.actor!.id,
      stepId: params.stepId,
      idempotencyKey: key,
      requestFingerprint: onboardingCommandRequestFingerprint({ stepId: params.stepId }),
      requestId: request.requestId
    });
    return sendOnboardingCommand(reply, request.requestId, result);
  });

  app.post("/v1/onboarding/steps/:stepId/view", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key))
      return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const params = stepParamsSchema.parse(request.params);
    const body = viewBodySchema.parse(request.body ?? {});
    const result = onboarding.recordViewEvent({
      userId: request.actor!.id,
      stepId: params.stepId,
      path: body.path,
      idempotencyKey: key,
      requestFingerprint: onboardingCommandRequestFingerprint({ stepId: params.stepId, path: body.path }),
      requestId: request.requestId
    });
    return sendOnboardingCommand(reply, request.requestId, result);
  });

  app.post("/v1/onboarding/reward/claim", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key))
      return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    emptyBodySchema.parse(request.body ?? {});
    if (!hasArchive(database, request.actor!.id))
      return reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", "请先创建游戏存档"));
    const result = onboarding.claimReward({
      userId: request.actor!.id,
      idempotencyKey: key,
      requestFingerprint: onboardingCommandRequestFingerprint({}),
      requestId: request.requestId
    });
    return sendOnboardingCommand(reply, request.requestId, result);
  });
}

function sendOnboardingCommand(
  reply: { code: (statusCode: number) => { send: (payload: unknown) => unknown } },
  requestId: string,
  result: OnboardingCommandResult
) {
  if (result.state === "conflict")
    return reply.code(409).send(failure(requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
  if (result.state === "in-progress")
    return reply.code(409).send(failure(requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
  return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
}
