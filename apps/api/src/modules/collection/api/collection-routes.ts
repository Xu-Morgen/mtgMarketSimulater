import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { CollectionService } from "../application/collection-service.js";

const albumQuerySchema = z
  .object({
    onlyHeld: z.enum(["any", "held"]).default("any"),
    cursor: z.string().regex(/^\d+$/).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20)
  })
  .strict();

/** I33B：收藏图鉴只读路由。聚合全部来自服务端目录与库存快照，浏览器不得统计或估值。 */
export async function registerCollectionRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const collection = new CollectionService(database);
  app.get("/v1/collection/album", { preHandler: requireRole("player") }, async (request) => {
    const query = albumQuerySchema.parse(request.query);
    return success(
      request.requestId,
      collection.album(request.actor!.id, {
        onlyHeld: query.onlyHeld === "held",
        cursor: query.cursor,
        limit: query.limit
      })
    );
  });
}
