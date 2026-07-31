/**
 * I31B SQLite 一致性备份领域模型与纯策略。备份记录只追加，绝不删最近成功备份；
 * 保留策略在纯函数中决定要清理哪些旧记录，调用方负责实际删除磁盘文件。
 */

export type BackupKind = "scheduled" | "manual" | "predeploy";
export type BackupStatus = "running" | "succeeded" | "failed";

export interface BackupRecord {
  id: string;
  kind: BackupKind;
  status: BackupStatus;
  sourceSqlitePath: string;
  backupFileName: string | null;
  backupPathRelative: string | null;
  sizeBytes: number | null;
  sqliteIntegrityOk: boolean | null;
  sha256: string | null;
  failureReason: string | null;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
  requestId: string | null;
  idempotencyKey: string;
}

/**
 * 保留策略：按 createdAt 降序保留前 N 份 succeeded 记录，返回超出保留数量的旧记录供清理。
 * 永不返回最新成功记录——即使 retention=0 也只清理非最新，避免误删全部备份。
 * failed/running 记录不参与保留计数，但可由调用方按需清理（此处只返回 succeeded 淘汰项）。
 */
export function retentionToKeep(records: ReadonlyArray<Pick<BackupRecord, "id" | "status" | "createdAt">>, retention: number): Array<Pick<BackupRecord, "id" | "createdAt">> {
  if (retention < 1) throw new RangeError("保留份数必须为正整数");
  const succeeded = records
    .filter((record) => record.status === "succeeded")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  // 至少保留最新成功备份，无论 retention 多大（retention 已 >=1，此处为防御性）。
  const keepCount = Math.max(1, retention);
  return succeeded.slice(keepCount).map((record) => ({ id: record.id, createdAt: record.createdAt }));
}
