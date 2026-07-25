import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey } from "@mtg-market/contracts";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { packOpenRequestFingerprint, PackService } from "../application/pack-service.js";

const packParamsSchema = z.object({ packId: z.string().uuid() }).strict();
const openPackBodySchema = z.object({ ruleVersion: z.string().trim().min(1).max(120) }).strict();
const openingHistoryQuerySchema = z
  .object({
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  })
  .strict();

/** 仅公示服务端版本化配置；不暴露候选池、随机种子、保底或任何开奖写命令。 */
export async function registerPackRoutes(
  app: FastifyInstance,
  database: Database.Database
): Promise<void> {
  const packs = new PackService(database);
  app.get("/v1/packs", { preHandler: requireRole("player") }, async (request) =>
    success(request.requestId, { items: packs.list() })
  );
  app.get("/v1/packs/:packId", { preHandler: requireRole("player") }, async (request, reply) => {
    const pack = packs.detail(packParamsSchema.parse(request.params).packId);
    return pack
      ? success(request.requestId, { pack })
      : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "补充包不存在"));
  });
  app.get("/v1/store/packs", { preHandler: requireRole("player") }, async (request) =>
    success(request.requestId, { items: packs.shopList() })
  );
  app.get(
    "/v1/store/packs/:packId/purchase-preview",
    { preHandler: requireRole("player") },
    async (request, reply) => {
      const preview = packs.purchasePreview(
        request.actor!.id,
        packParamsSchema.parse(request.params).packId
      );
      if (preview === "not-found")
        return reply
          .code(404)
          .send(failure(request.requestId, "RESOURCE_NOT_FOUND", "补充包不存在"));
      if (preview === "disabled")
        return reply
          .code(409)
          .send(failure(request.requestId, "RESOURCE_CONFLICT", "补充包当前已下架"));
      if (preview === "invalid")
        return reply
          .code(409)
          .send(failure(request.requestId, "RULE_VIOLATION", "补充包配置包含无效卡牌"));
      return success(request.requestId, { preview });
    }
  );
  app.post(
    "/v1/packs/:packId/open",
    { preHandler: requireRole("player") },
    async (request, reply) => {
      const key = request.headers["idempotency-key"];
      if (typeof key !== "string" || !isValidIdempotencyKey(key))
        return reply
          .code(400)
          .send(
            failure(
              request.requestId,
              "IDEMPOTENCY_KEY_REQUIRED",
              "写请求必须携带格式正确的 Idempotency-Key"
            )
          );
      const body = openPackBodySchema.parse(request.body);
      const result = packs.openForPurchase({
        userId: request.actor!.id,
        packId: packParamsSchema.parse(request.params).packId,
        ruleVersion: body.ruleVersion,
        idempotencyKey: key,
        requestFingerprint: packOpenRequestFingerprint(body),
        requestId: request.requestId
      });
      if (result.state === "conflict")
        return reply
          .code(409)
          .send(
            failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求")
          );
      if (result.state === "in-progress")
        return reply
          .code(409)
          .send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
      return reply
        .code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode)
        .send(result.response);
    }
  );
  app.get("/v1/pack-openings", { preHandler: requireRole("player") }, async (request) => {
    const query = openingHistoryQuerySchema.parse(request.query);
    return success(
      request.requestId,
      packs.openingHistory(request.actor!.id, query.cursor, query.limit)
    );
  });
}
