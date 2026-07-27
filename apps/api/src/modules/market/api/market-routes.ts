import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { success, failure } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { MarketService } from "../application/market-service.js";

export async function registerMarketRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const market = new MarketService(database);
  app.get("/v1/market/quotes/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const { skuId } = z.object({ skuId: z.string().uuid() }).parse(request.params);
    const quote = market.quote(skuId);
    if (!quote) return reply.code(404).send(failure(request.requestId, "PRICE_UNAVAILABLE", "该 SKU 暂无有效游戏内报价"));
    return success(request.requestId, { quote });
  });
  app.get("/v1/market/index", { preHandler: requireRole("player") }, async (request) => success(request.requestId, market.index()));
}
