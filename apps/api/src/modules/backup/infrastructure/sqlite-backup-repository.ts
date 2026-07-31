import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BackupKind, BackupRecord, BackupStatus } from "../domain/backup.js";

type BackupRow = {
  id: string;
  kind: string;
  status: string;
  source_sqlite_path: string;
  backup_file_name: string | null;
  backup_path_relative: string | null;
  size_bytes: number | null;
  sqlite_integrity_ok: number | null;
  sha256: string | null;
  failure_reason: string | null;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  request_id: string | null;
  idempotency_key: string;
};

function toRecord(row: BackupRow): BackupRecord {
  return {
    id: row.id,
    kind: row.kind as BackupKind,
    status: row.status as BackupStatus,
    sourceSqlitePath: row.source_sqlite_path,
    backupFileName: row.backup_file_name,
    backupPathRelative: row.backup_path_relative,
    sizeBytes: row.size_bytes,
    sqliteIntegrityOk: row.sqlite_integrity_ok === null ? null : row.sqlite_integrity_ok === 1,
    sha256: row.sha256,
    failureReason: row.failure_reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key
  };
}

const SELECT_COLUMNS = "id, kind, status, source_sqlite_path, backup_file_name, backup_path_relative, size_bytes, sqlite_integrity_ok, sha256, failure_reason, created_by, created_at, completed_at, request_id, idempotency_key";

/** I31B 备份记录仓储：只追加事实，失败只追加 failed，绝不删最近成功备份。 */
export class SqliteBackupRepository {
  constructor(private readonly database: Database.Database) {}

  insert(input: { kind: BackupKind; sourceSqlitePath: string; createdBy: string; requestId: string | null; idempotencyKey: string; now: string }): BackupRecord {
    const id = randomUUID();
    this.database
      .prepare("INSERT INTO backup_records (id, kind, status, source_sqlite_path, created_by, created_at, request_id, idempotency_key) VALUES (?, ?, 'running', ?, ?, ?, ?, ?)")
      .run(id, input.kind, input.sourceSqlitePath, input.createdBy, input.now, input.requestId, input.idempotencyKey);
    return this.get(id)!;
  }

  complete(input: { id: string; backupFileName: string; backupPathRelative: string; sizeBytes: number; sqliteIntegrityOk: boolean; sha256: string; now: string }): void {
    this.database
      .prepare("UPDATE backup_records SET status = 'succeeded', backup_file_name = ?, backup_path_relative = ?, size_bytes = ?, sqlite_integrity_ok = ?, sha256 = ?, completed_at = ? WHERE id = ? AND status = 'running'")
      .run(input.backupFileName, input.backupPathRelative, input.sizeBytes, input.sqliteIntegrityOk ? 1 : 0, input.sha256, input.now, input.id);
  }

  fail(input: { id: string; reason: string; now: string }): void {
    this.database
      .prepare("UPDATE backup_records SET status = 'failed', failure_reason = ?, completed_at = ? WHERE id = ? AND status = 'running'")
      .run(input.reason, input.now, input.id);
  }

  markExpired(id: string, now: string): void {
    this.database.prepare("UPDATE backup_records SET status = 'failed', failure_reason = 'expired', completed_at = ? WHERE id = ?").run(now, id);
  }

  get(id: string): BackupRecord | null {
    const row = this.database.prepare(`SELECT ${SELECT_COLUMNS} FROM backup_records WHERE id = ?`).get(id) as BackupRow | undefined;
    return row ? toRecord(row) : null;
  }

  list(limit: number): BackupRecord[] {
    const rows = this.database.prepare(`SELECT ${SELECT_COLUMNS} FROM backup_records ORDER BY created_at DESC, id DESC LIMIT ?`).all(limit) as BackupRow[];
    return rows.map(toRecord);
  }

  listByKind(kind: BackupKind, limit: number): BackupRecord[] {
    const rows = this.database.prepare(`SELECT ${SELECT_COLUMNS} FROM backup_records WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT ?`).all(kind, limit) as BackupRow[];
    return rows.map(toRecord);
  }

  latestSucceeded(): BackupRecord | null {
    const row = this.database.prepare(`SELECT ${SELECT_COLUMNS} FROM backup_records WHERE status = 'succeeded' ORDER BY created_at DESC, id DESC LIMIT 1`).get() as BackupRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** 幂等去重：同 idempotencyKey 已存在则返回首次记录，调用方据此跳过重复备份。 */
  findByIdempotency(idempotencyKey: string): BackupRecord | null {
    const row = this.database.prepare(`SELECT ${SELECT_COLUMNS} FROM backup_records WHERE idempotency_key = ? ORDER BY created_at DESC LIMIT 1`).get(idempotencyKey) as BackupRow | undefined;
    return row ? toRecord(row) : null;
  }
}
