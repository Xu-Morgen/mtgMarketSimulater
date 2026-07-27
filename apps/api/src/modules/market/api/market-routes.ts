import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { success, failure } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { MarketService } from "../application/market-service.js";

const listQuerySchema = z.object({
  query: z.string().trim().min(1).max(120).optional(),
  setCode: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()).optional(),
  rarity: z.string().trim().min(1).max(40).optional(),
  finish: z.enum(["nonfoil", "foil", "etched"]).optional(),
  tradable: z.enum(["any", "tradable", "untradable"]).default("any"),
  cursor: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();
const historyQuerySchema = z.object({ range: z.enum(["7d", "30d", "all"]).default("30d") }).strict();

export async function registerMarketRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const market = new MarketService(database);
  app.get("/v1/market/quotes", { preHandler: requireRole("player") }, async (request) =>
    success(request.requestId, market.list(listQuerySchema.parse(request.query)))
  );
  app.get("/v1/market/quotes/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const { skuId } = z.object({ skuId: z.string().uuid() }).parse(request.params);
    const quote = market.quote(skuId);
    if (!quote) return reply.code(404).send(failure(request.requestId, "PRICE_UNAVAILABLE", "该 SKU 暂无有效游戏内报价"));
    return success(request.requestId, { quote });
  });
  app.get("/v1/market/quotes/:skuId/history", { preHandler: requireRole("player") }, async (request) => {
    const { skuId } = z.object({ skuId: z.string().uuid() }).parse(request.params);
    const { range } = historyQuerySchema.parse(request.query);
    return success(request.requestId, market.history(skuId, range));
  });
  app.get("/v1/market/index", { preHandler: requireRole("player") }, async (request) => success(request.requestId, market.index()));
  app.get("/v1/market/index/history", { preHandler: requireRole("player") }, async (request) => {
    const { range } = historyQuerySchema.parse(request.query);
    return success(request.requestId, market.indexHistory(range));
  });
}
