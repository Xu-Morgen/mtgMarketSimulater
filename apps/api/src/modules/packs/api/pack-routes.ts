import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { PackService } from "../application/pack-service.js";

const packParamsSchema = z.object({ packId: z.string().uuid() }).strict();

/** 仅公示服务端版本化配置；不暴露候选池、随机种子、保底或任何开奖写命令。 */
export async function registerPackRoutes(app: FastifyInstance, database: Database.Database): Promise<void> {
  const packs = new PackService(database);
  app.get("/v1/packs", { preHandler: requireRole("player") }, async (request) => success(request.requestId, { items: packs.list() }));
  app.get("/v1/packs/:packId", { preHandler: requireRole("player") }, async (request, reply) => {
    const pack = packs.detail(packParamsSchema.parse(request.params).packId);
    return pack ? success(request.requestId, { pack }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "补充包不存在"));
  });
}
