import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExportRecord } from "../domain/export-record.js";

type ExportRow = {
  id: string;
  user_id: string;
  kind: string;
  format: string;
  backup_file_name: string;
  file_path_relative: string;
  size_bytes: number | null;
  expires_at: string;
  status: string;
  failure_reason: string | null;
  request_id: string | null;
  idempotency_key: string;
  created_at: string;
  completed_at: string | null;
};

function toRecord(row: ExportRow): ExportRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind as ExportRecord["kind"],
    format: row.format as ExportRecord["format"],
    fileName: row.backup_file_name,
    filePathRelative: row.file_path_relative,
    sizeBytes: row.size_bytes,
    expiresAt: row.expires_at,
    status: row.status as ExportRecord["status"],
    failureReason: row.failure_reason,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    completedAt: row.completed_at
  };
}

const COLUMNS = "id, user_id, kind, format, backup_file_name, file_path_relative, size_bytes, expires_at, status, failure_reason, request_id, idempotency_key, created_at, completed_at";

/** I31B 导出记录仓储。UNIQUE(idempotency_key) 保证同键重放返回首次记录。 */
export class SqliteExportRecordRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: { userId: string; kind: ExportRecord["kind"]; format: ExportRecord["format"]; fileName: string; filePathRelative: string; expiresAt: string; requestId: string | null; idempotencyKey: string; now: string }): ExportRecord {
    const id = randomUUID();
    this.database
      .prepare("INSERT INTO export_records (id, user_id, kind, format, backup_file_name, file_path_relative, expires_at, status, request_id, idempotency_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)")
      .run(id, input.userId, input.kind, input.format, input.fileName, input.filePathRelative, input.expiresAt, input.requestId, input.idempotencyKey, input.now);
    return this.get(id)!;
  }

  complete(input: { id: string; sizeBytes: number; now: string }): void {
    this.database.prepare("UPDATE export_records SET status = 'succeeded', size_bytes = ?, completed_at = ? WHERE id = ? AND status = 'running'").run(input.sizeBytes, input.now, input.id);
  }

  fail(input: { id: string; reason: string; now: string }): void {
    this.database.prepare("UPDATE export_records SET status = 'failed', failure_reason = ?, completed_at = ? WHERE id = ? AND status = 'running'").run(input.reason, input.now, input.id);
  }

  get(id: string): ExportRecord | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM export_records WHERE id = ?`).get(id) as ExportRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 服务端复核 ownership：按 id 且 user_id 查询，越权访问返回 null。 */
  getForUser(id: string, userId: string): ExportRecord | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM export_records WHERE id = ? AND user_id = ?`).get(id, userId) as ExportRow | undefined;
    return row ? toRecord(row) : null;
  }

  listByUser(userId: string, limit: number): ExportRecord[] {
    const rows = this.database.prepare(`SELECT ${COLUMNS} FROM export_records WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(userId, limit) as ExportRow[];
    return rows.map(toRecord);
  }

  findByIdempotency(idempotencyKey: string): ExportRecord | null {
    const row = this.database.prepare(`SELECT ${COLUMNS} FROM export_records WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1`).get(idempotencyKey) as ExportRow | undefined;
    return row ? toRecord(row) : null;
  }

  listExpired(now: string, limit: number): ExportRecord[] {
    // 含已标记 expired 但文件尚未清理的记录，以及 running/succeeded 但已过期的记录。
    const rows = this.database.prepare(`SELECT ${COLUMNS} FROM export_records WHERE status IN ('running','succeeded','expired') AND expires_at < ? AND completed_at IS NOT NULL LIMIT ?`).all(now, limit) as ExportRow[];
    return rows.map(toRecord);
  }

  markExpired(id: string, now: string): void {
    this.database.prepare("UPDATE export_records SET status = 'expired', completed_at = ? WHERE id = ?").run(now, id);
  }
}
