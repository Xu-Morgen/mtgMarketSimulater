import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { InventoryService } from "../application/inventory-service.js";

const listQuerySchema = z.object({ query: z.string().trim().min(1).max(120).optional(), setCode: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()).optional(), finish: z.enum(["nonfoil", "foil", "etched"]).optional(), locked: z.enum(["any", "locked", "available"]).default("any"), sort: z.enum(["updatedAt", "name", "quantity", "availableQuantity"]).default("updatedAt"), direction: z.enum(["asc", "desc"]).default("desc"), cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();
const skuParamsSchema = z.object({ skuId: z.string().uuid() }).strict();
const entriesQuerySchema = z.object({ cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(20) }).strict();

/** 仅暴露服务端库存真相查询；浏览器不能直接改数量、成本或锁定状态。 */
export async function registerInventoryRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const inventory = new InventoryService(database);
  app.get("/v1/inventory", { preHandler: requireRole("player") }, async (request) => success(request.requestId, inventory.list(request.actor!.id, listQuerySchema.parse(request.query))));
  app.get("/v1/inventory/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const holding = inventory.holding(request.actor!.id, skuParamsSchema.parse(request.params).skuId);
    return holding ? success(request.requestId, { holding }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "未持有该卡牌 SKU"));
  });
  app.get("/v1/inventory/:skuId/reconciliation", { preHandler: requireRole("player") }, async (request, reply) => {
    const skuId = skuParamsSchema.parse(request.params).skuId; const query = entriesQuerySchema.parse(request.query);
    const result = inventory.reconciliation(request.actor!.id, skuId, query.cursor, query.limit);
    return result ? success(request.requestId, result) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "未持有该卡牌 SKU"));
  });
}
