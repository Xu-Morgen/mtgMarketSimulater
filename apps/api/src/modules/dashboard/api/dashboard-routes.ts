import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import type { ApiConfig } from "../../../config/environment.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { LeylineClient } from "../../decks/infrastructure/leyline-client.js";
import { TournamentService } from "../../tournaments/application/tournament-service.js";
import { PlayerDashboardService } from "../application/player-dashboard-service.js";

/** 首页 HTTP 层只映射会话、404 语义与响应包络；聚合规则在 dashboard application。 */
export async function registerDashboardRoutes(app: FastifyInstance, database: Database.Database, config: Pick<ApiConfig, "APP_TIMEZONE" | "DAILY_WORK_FUNDING_RULE_VERSION" | "DECK_RESPONSE_ENCRYPTION_KEY" | "LEYLINE_ENDPOINT" | "LEYLINE_TIMEOUT_MS" | "LEYLINE_MAX_RETRIES">): Promise<void> {
  const tournaments = new TournamentService(database, {
    timezone: config.APP_TIMEZONE,
    encryptionKey: config.DECK_RESPONSE_ENCRYPTION_KEY,
    leyline: new LeylineClient({ endpoint: config.LEYLINE_ENDPOINT, timeoutMs: config.LEYLINE_TIMEOUT_MS, maxRetries: config.LEYLINE_MAX_RETRIES }),
    logger: app.log
  });
  const dashboard = new PlayerDashboardService(tournaments, database, { timezone: config.APP_TIMEZONE, ruleVersion: config.DAILY_WORK_FUNDING_RULE_VERSION }, config.APP_TIMEZONE);
  app.get("/v1/dashboard", { preHandler: requireRole("player") }, async (request, reply) => {
    const overview = dashboard.overview(request.actor!.id);
    return overview
      ? success(request.requestId, { overview })
      : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "尚未创建游戏存档"));
  });
}
