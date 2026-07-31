import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey, type ExportRecordDto } from "@mtg-market/contracts";
import type { ApiConfig } from "../../../config/environment.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { ExportService } from "../application/export-service.js";
import type { ExportRecord } from "../domain/export-record.js";
import { streamDownload } from "../../backup/api/backup-routes.js";

function toExportDto(record: ExportRecord): ExportRecordDto {
  return {
    id: record.id,
    kind: record.kind,
    format: record.format,
    fileName: record.fileName,
    sizeBytes: record.sizeBytes,
    status: record.status,
    failureReason: record.failureReason,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt
  };
}

const contentType = (format: "csv" | "json"): string => (format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8");

/**
 * I31B 玩家导出路由。player 角色；触发生成需 Idempotency-Key。
 * 下载时服务端再次复核 ownership 防越权；文件路径不外泄，只下发受控下载流。
 */
export async function registerExportRoutes(app: FastifyInstance, config: Pick<ApiConfig, "EXPORT_DIR" | "EXPORT_TTL_SECONDS">, database: Database.Database): Promise<void> {
  const exportService = new ExportService(database, config);

  app.get("/v1/exports", { preHandler: requireRole("player") }, async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(request.query);
    return success(request.requestId, { items: exportService.listForUser(request.actor!.id, limit).map(toExportDto) });
  });

  app.post("/v1/exports", { preHandler: requireRole("player") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = z.object({ formats: z.array(z.enum(["csv", "json"])).min(1).max(2) }).strict().parse(request.body ?? { formats: ["csv"] });
    const result = exportService.generate({ userId: request.actor!.id, requestId: request.requestId, idempotencyKey: key, formats: body.formats });
    const record = result.record;
    const statusCode = record.status === "succeeded" ? 201 : record.status === "failed" ? 500 : 202;
    return reply.code(statusCode).send(success(request.requestId, { export: toExportDto(record), skipped: result.skipped }));
  });

  app.get("/v1/exports/:id/download", { preHandler: requireRole("player") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    // 服务端复核 ownership：必须属于当前玩家、succeeded 且未过期；否则 404 不泄露存在性。
    const record = exportService.downloadableForUser(id, request.actor!.id);
    if (!record) return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "导出不存在、已过期或不可下载"));
    return streamDownload(reply, exportService.absolutePath(record), record.fileName, contentType(record.format));
  });
}

/** 复用随机 UUID 生成（审计/记录 id），保持与 backup 模块一致风格。 */
export function exportUuid(): string {
  return randomUUID();
}
