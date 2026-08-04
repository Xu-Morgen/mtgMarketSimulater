import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey } from "@mtg-market/contracts";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { watchlistPathRequestFingerprint, watchlistUpsertRequestFingerprint, WatchlistService } from "../application/watchlist-service.js";

const skuParams = z.object({ skuId: z.string().uuid() }).strict();
const alertParams = z.object({ alertId: z.string().uuid() }).strict();
const upsertBody = z.object({
  skuId: z.string().uuid(),
  targetType: z.enum(["game_price", "reference_price"]),
  direction: z.enum(["at_or_below", "at_or_above"]),
  targetAmount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  enabled: z.boolean()
}).strict();

/**
 * I34B（E12）：Watchlist HTTP 边界。写操作只提交用户意图与幂等键，目标价/方向/命中判定
 * 均由服务端保存与执行；浏览器不得自判命中或推算触发价。
 */
export async function registerWatchlistRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const watchlist = new WatchlistService(database);

  app.get("/v1/watchlist", { preHandler: requireRole("player") }, async (request) =>
    success(request.requestId, { items: watchlist.list(request.actor!.id), limits: watchlist.limits() })
  );

  app.post("/v1/watchlist", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = upsertBody.parse(request.body);
    const result = watchlist.upsert({ userId: request.actor!.id, ...body, idempotencyKey: key, requestFingerprint: watchlistUpsertRequestFingerprint(body), requestId: request.requestId });
    if (result.state === "conflict") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
    if (result.state === "in-progress") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
    return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
  });

  app.delete("/v1/watchlist/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const { skuId } = skuParams.parse(request.params);
    const result = watchlist.remove({ userId: request.actor!.id, skuId, idempotencyKey: key, requestFingerprint: watchlistPathRequestFingerprint({ skuId }), requestId: request.requestId });
    if (result.state === "conflict") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
    if (result.state === "in-progress") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
    return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
  });

  app.get("/v1/watchlist/alerts", { preHandler: requireRole("player") }, async (request) =>
    success(request.requestId, watchlist.alerts(request.actor!.id))
  );

  app.post("/v1/watchlist/alerts/:alertId/read", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const { alertId } = alertParams.parse(request.params);
    const result = watchlist.markAlertRead({ userId: request.actor!.id, alertId, idempotencyKey: key, requestFingerprint: watchlistPathRequestFingerprint({ alertId }), requestId: request.requestId });
    if (result.state === "conflict") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
    if (result.state === "in-progress") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
    return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
  });
}
