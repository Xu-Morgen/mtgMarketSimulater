import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { CatalogService } from "../application/catalog-service.js";
import { SqliteCatalogRepository } from "../infrastructure/sqlite-catalog-repository.js";

const listQuerySchema = z.object({
  query: z.string().trim().min(1).max(120).optional(), setCode: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()).optional(),
  rarity: z.string().trim().min(1).max(40).optional(), finish: z.enum(["nonfoil", "foil", "etched"]).optional(),
  cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();
const skuParamsSchema = z.object({ skuId: z.string().uuid() }).strict();

/** 浏览器只能读取本地目录；I09 前没有任何外部 Provider 访问路径。 */
export async function registerCatalogRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const catalog = new CatalogService(new SqliteCatalogRepository(database));
  app.get("/v1/catalog/cards", { preHandler: requireRole("player") }, async (request) => success(request.requestId, catalog.list(listQuerySchema.parse(request.query))));
  app.get("/v1/catalog/cards/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const result = catalog.detail(skuParamsSchema.parse(request.params).skuId);
    return result ? success(request.requestId, { sku: result }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "卡牌 SKU 不存在"));
  });
}
