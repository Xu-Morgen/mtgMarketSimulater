import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { isValidIdempotencyKey, type BackupRecordDto, type BackupRestoreRehearsalDto } from "@mtg-market/contracts";
import type { ApiConfig } from "../../../config/environment.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { BackupService } from "../application/backup-service.js";
import type { BackupRecord } from "../domain/backup.js";

function toBackupDto(record: BackupRecord): BackupRecordDto {
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    backupFileName: record.backupFileName,
    sizeBytes: record.sizeBytes,
    sqliteIntegrityOk: record.sqliteIntegrityOk,
    sha256: record.sha256,
    failureReason: record.failureReason,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    completedAt: record.completedAt,
    requestId: record.requestId
  };
}

/**
 * I31B 备份管理路由。全部 admin 角色；写路由要求 Idempotency-Key、不可变审计。
 * 浏览器只看到文件名与受控下载流，绝不拿到源库绝对路径。
 */
export async function registerBackupRoutes(app: FastifyInstance, config: Pick<ApiConfig, "SQLITE_PATH" | "BACKUP_DIR" | "BACKUP_RETENTION" | "BACKUP_INTEGRITY_CHECK" | "EXPORT_DIR">, database: Database.Database): Promise<void> {
  const backup = new BackupService(database, config.SQLITE_PATH, config);

  app.get("/v1/admin/backups", { preHandler: requireRole("admin") }, async (request) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).default(20) }).strict().parse(request.query);
    return success(request.requestId, { items: backup.listBackups(limit).map(toBackupDto) });
  });

  app.get("/v1/admin/backups/:id", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const record = backup.getBackup(id);
    if (!record) return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "备份记录不存在"));
    return success(request.requestId, { backup: toBackupDto(record) });
  });

  app.post("/v1/admin/backups", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || !isValidIdempotencyKey(key)) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带格式正确的 Idempotency-Key"));
    const body = z.object({ kind: z.enum(["manual", "predeploy"]).default("manual") }).strict().parse(request.body ?? {});
    const result = await backup.runBackup({ kind: body.kind, actorId: request.actor!.id, requestId: request.requestId, idempotencyKey: key });
    // 记录管理审计：手动/预备份触发均写 audit_logs，便于追溯。
    database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'backup.triggered', 'backup_record', ?, ?, ?, ?)").run(cryptoUuid(), request.actor!.id, result.record.id, request.requestId, JSON.stringify({ backupId: result.record.id, kind: body.kind, status: result.record.status, skipped: result.skipped }), new Date().toISOString());
    const statusCode = result.record.status === "succeeded" ? 201 : result.record.status === "failed" ? 500 : 202;
    return reply.code(statusCode).send(success(request.requestId, { backup: toBackupDto(result.record), skipped: result.skipped }));
  });

  app.get("/v1/admin/backups/:id/download", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const record = backup.getBackup(id);
    if (!record) return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "备份记录不存在"));
    const absolutePath = backup.backupFileAbsolutePath(record);
    if (!absolutePath) return reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", "该备份不可下载（未成功或文件已清理）"));
    // 再次复核 admin 权限（requireRole 已校验）；下载用受控流，文件名来自服务端记录。
    database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'backup.downloaded', 'backup_record', ?, ?, ?, ?)").run(cryptoUuid(), request.actor!.id, record.id, request.requestId, JSON.stringify({ backupId: record.id, fileName: basename(absolutePath) }), new Date().toISOString());
    return streamDownload(reply, absolutePath, record.backupFileName ?? basename(absolutePath), "application/octet-stream");
  });

  app.post("/v1/admin/backups/:id/restore-rehearsal", { preHandler: requireRole("admin") }, async (request, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const result = backup.restoreRehearsal(id);
    if (result === "not-found") return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "备份记录不存在"));
    if (result === "not-succeeded") return reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", "仅成功备份可执行恢复演练"));
    database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'backup.restore_rehearsal', 'backup_record', ?, ?, ?, ?)").run(cryptoUuid(), request.actor!.id, result.backupId, request.requestId, JSON.stringify({ backupId: result.backupId, sqliteIntegrityOk: result.sqliteIntegrityOk, coreTablesPresent: result.coreTablesPresent }), new Date().toISOString());
    const dto: BackupRestoreRehearsalDto = result;
    return success(request.requestId, { rehearsal: dto });
  });
}

/** 受控文件下载：以流返回二进制，强制 attachment 防止浏览器内联执行，文件名来自服务端记录。 */
export function streamDownload(reply: FastifyReply, absolutePath: string, fileName: string, contentType: string): FastifyReply {
  return reply
    .header("Content-Type", contentType)
    .header("Content-Disposition", `attachment; filename="${fileName.replace(/"/g, "")}"`)
    .send(createReadStream(absolutePath));
}

function cryptoUuid(): string {
  // audit_logs.id 为 TEXT，使用 crypto.randomUUID 保证唯一。
  return randomUUID();
}
