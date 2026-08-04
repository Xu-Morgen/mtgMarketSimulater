import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey } from "@mtg-market/contracts";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { NpcTradeService, npcBuyRequestFingerprint, npcSellRequestFingerprint } from "../application/npc-trade-service.js";

const skuParams = z.object({ skuId: z.string().uuid() }).strict();
const previewQuery = z.object({ quantity: z.coerce.number().int().min(1).max(1000) }).strict();
const buyBody = z.object({ quoteId: z.string().uuid(), quoteVersion: z.string().trim().min(1).max(120), quantity: z.number().int().min(1).max(1000), maxUnitPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
const sellPreviewQuery = z.object({ quantity: z.union([z.coerce.number().int().min(1).max(1000), z.literal("all")]) }).strict();
const sellBody = z.object({ quoteId: z.string().uuid(), quoteVersion: z.string().trim().min(1).max(120), quantity: z.number().int().min(1).max(1000), minUnitPrice: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
/** I33B（C8）重复卡批量卖出：请求体为空对象，结算只按服务端库存/报价投影推进。 */
const sellDuplicatesBody = z.object({}).strict();

/** NPC 买入 HTTP 边界：只验证意图与幂等键，金额、费用、额度和结算均由 application 决定。 */
export async function registerNpcTradeRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const trades = new NpcTradeService(database);
  app.get("/v1/npc-trades/buy/:skuId/preview", { preHandler: requireRole("player") }, async (request, reply) => {
    const preview = trades.buyPreview(request.actor!.id, skuParams.parse(request.params).skuId, previewQuery.parse(request.query).quantity);
    if (preview === "quote-unavailable") return reply.code(404).send(failure(request.requestId, "PRICE_UNAVAILABLE", "该 SKU 暂无可结算报价"));
    if (preview === "quote-stale") return reply.code(409).send(failure(request.requestId, "VERSION_STALE", "报价已过期，请等待服务端刷新报价"));
    return success(request.requestId, { preview });
  });
  app.post("/v1/npc-trades/buy/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = buyBody.parse(request.body);
    const result = trades.buy({ userId: request.actor!.id, skuId: skuParams.parse(request.params).skuId, ...body, idempotencyKey: key, requestFingerprint: npcBuyRequestFingerprint(body), requestId: request.requestId });
    if (result.state === "conflict") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
    if (result.state === "in-progress") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
    return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
  });
  app.get("/v1/npc-trades/sell/:skuId/preview", { preHandler: requireRole("player") }, async (request, reply) => {
    const preview = trades.sellPreview(request.actor!.id, skuParams.parse(request.params).skuId, sellPreviewQuery.parse(request.query).quantity);
    if (preview === "quote-unavailable") return reply.code(404).send(failure(request.requestId, "PRICE_UNAVAILABLE", "该 SKU 暂无可结算报价"));
    if (preview === "quote-stale") return reply.code(409).send(failure(request.requestId, "VERSION_STALE", "报价已过期，请等待服务端刷新报价"));
    return success(request.requestId, { preview });
  });
  app.post("/v1/npc-trades/sell/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = sellBody.parse(request.body);
    const result = trades.sell({ userId: request.actor!.id, skuId: skuParams.parse(request.params).skuId, ...body, idempotencyKey: key, requestFingerprint: npcSellRequestFingerprint(body), requestId: request.requestId });
    if (result.state === "conflict") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
    if (result.state === "in-progress") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
    return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
  });
  // I33B（C8）：按筛选/全持有批量向 NPC 卖出重复卡；只提交意图，逐 SKU 结算由服务端在单事务内完成。
  app.post("/v1/inventory/duplicates/sell", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    sellDuplicatesBody.parse(request.body);
    const result = trades.sellDuplicates({ userId: request.actor!.id, idempotencyKey: key, requestFingerprint: npcSellRequestFingerprint({}), requestId: request.requestId });
    if (result.state === "conflict") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_CONFLICT", "Idempotency-Key 已用于不同请求"));
    if (result.state === "in-progress") return reply.code(409).send(failure(request.requestId, "IDEMPOTENCY_IN_PROGRESS", "相同请求正在处理中"));
    return reply.code(result.state === "replayed" && result.response.ok ? 200 : result.statusCode).send(result.response);
  });
}
