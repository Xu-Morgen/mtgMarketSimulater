import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiConfig } from "../../../config/environment.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { AchievementService } from "../application/achievement-service.js";

// 成就定义 ID 形如 `first-tournament/v1`，包含路径分隔符；详情查询用 query 参数避免与路径段冲突。
const definitionIdQuery = z.object({ definitionId: z.string().trim().min(1).max(100) }).strict();

/**
 * 成就查询为只读：浏览器只展示服务端已结算的成就定义、进度、解锁与来源，绝不自行解锁或发奖。
 * 解锁与奖励由 `achievement.process` 任务在赛事结算后原子完成。
 */
export async function registerAchievementRoutes(app: FastifyInstance, database: Database.Database, config: Pick<ApiConfig, "APP_TIMEZONE">): Promise<void> {
  const achievements = new AchievementService(database, { timezone: config.APP_TIMEZONE });

  app.get("/v1/achievements", { preHandler: requireRole("player") }, async (request) =>
    success(request.requestId, { items: achievements.overview(request.actor!.id) })
  );

  app.get("/v1/achievements/unlocks", { preHandler: requireRole("player") }, async (request) =>
    success(request.requestId, { items: achievements.unlocks(request.actor!.id) })
  );

  // 详情通过 ?definitionId= 查询；定义 ID 含 `/v1` 后缀，用路径段会与路由匹配冲突。
  app.get("/v1/achievements/detail", { preHandler: requireRole("player") }, async (request, reply) => {
    const detail = achievements.detail(request.actor!.id, definitionIdQuery.parse(request.query).definitionId);
    return detail ? success(request.requestId, detail) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "成就不存在"));
  });
}

export function createAchievementService(database: Database.Database, config: Pick<ApiConfig, "APP_TIMEZONE">): AchievementService {
  return new AchievementService(database, { timezone: config.APP_TIMEZONE });
}
