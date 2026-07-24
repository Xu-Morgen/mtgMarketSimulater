import cors from "@fastify/cors";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError, z } from "zod";
import { calculateNpcQuote } from "@mtg-market/rules";
import type { ApiConfig } from "./config/environment.js";
import { openApiDocument } from "./openapi.js";
import { failure, success } from "./shared/http/api-response.js";
import { REQUEST_ID_HEADER, resolveRequestId } from "./shared/http/request-context.js";

declare module "fastify" {
  interface FastifyRequest {
    requestId: string;
  }
}

const quotePreviewQuerySchema = z.object({
  referencePrice: z.coerce.number().int().min(0).default(10),
  marketFactor: z.coerce.number().min(0.1).max(10).default(1),
  buySpread: z.coerce.number().min(0).max(1).default(0.1),
  sellSpread: z.coerce.number().min(0).max(1).default(0.1)
}).strict();

function jobHealthSummary(database: Database.Database) {
  const rows = database
    .prepare("SELECT status, COUNT(*) AS count FROM jobs GROUP BY status")
    .all() as Array<{ status: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

function databaseHealth(database: Database.Database) {
  database.prepare("SELECT 1").get();
  return { status: "ok" as const, storage: "sqlite-wal" as const };
}

/** HTTP 横切层：请求标识、脱敏结构化日志、统一包络与外部输入边界。 */
export async function createApiApp(config: ApiConfig, database: Database.Database): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.APP_ENV === "test" ? "silent" : "info",
      redact: { paths: ["req.headers.authorization", "req.headers.cookie", "req.headers.x-api-key", "password", "token"], censor: "[REDACTED]" }
    },
    genReqId: () => randomUUID()
  });

  await app.register(cors, {
    origin: (origin, callback) => callback(null, origin === undefined || config.CORS_ORIGINS.includes(origin)),
    credentials: true
  });

  app.addHook("onRequest", async (request, reply) => {
    request.requestId = resolveRequestId(request);
    reply.header(REQUEST_ID_HEADER, request.requestId);
  });

  /**
   * 身份模块上线前 actor 为空；后续认证 hook 会填充可信 actor。审计摘要刻意不保存
   * 请求体，避免密码、刷新令牌等敏感输入进入日志或审计表。
   */
  app.addHook("onResponse", async (request, reply) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) || !request.routeOptions.url) return;
    const idempotencyKey = request.headers["idempotency-key"];
    database
      .prepare(
        "INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        randomUUID(),
        null,
        `HTTP ${request.method}`,
        "http_route",
        request.routeOptions.url,
        request.requestId,
        JSON.stringify({ statusCode: reply.statusCode, idempotencyKey: Array.isArray(idempotencyKey) ? idempotencyKey[0] : idempotencyKey ?? null }),
        new Date().toISOString()
      );
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "请求的资源不存在"))
  );

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send(failure(request.requestId, "VALIDATION_FAILED", "请求参数无效", { issues: error.issues }));
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      return reply.code(error.statusCode).send(failure(request.requestId, "VALIDATION_FAILED", "请求格式无效"));
    }
    request.log.error({ err: error, requestId: request.requestId }, "未处理的 API 异常");
    return reply.code(500).send(failure(request.requestId, "INTERNAL_ERROR", "服务器内部错误"));
  });

  app.get("/health", async (request) => success(request.requestId, { status: "ok", database: databaseHealth(database) }));

  app.get("/ready", async (request, reply) => {
    try {
      return success(request.requestId, { status: "ready", database: databaseHealth(database), jobs: jobHealthSummary(database) });
    } catch (error) {
      request.log.error({ err: error, requestId: request.requestId }, "就绪检查失败");
      return reply.code(503).send(failure(request.requestId, "INTERNAL_ERROR", "服务尚未就绪"));
    }
  });

  app.get("/openapi.json", async () => openApiDocument);

  app.get("/v1/market/quote-preview", async (request) => {
    const query = quotePreviewQuerySchema.parse(request.query);
    return success(request.requestId, calculateNpcQuote(query));
  });

  return app;
}
