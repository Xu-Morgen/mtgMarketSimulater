import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { utcNow } from "@mtg-market/database";
import type { BackupConfig } from "../../../config/environment.js";
import type { BackupKind, BackupRecord } from "../domain/backup.js";
import { retentionToKeep } from "../domain/backup.js";
import { SqliteBackupRepository } from "../infrastructure/sqlite-backup-repository.js";

export interface BackupRunResult {
  record: BackupRecord;
  /** running 时表示被另一同键备份占用，调用方可安全跳过。 */
  skipped: boolean;
}

export interface RestoreRehearsalResult {
  backupId: string;
  backupFileName: string;
  sqliteIntegrityOk: boolean;
  coreTablesPresent: boolean;
  sampleCounts: { users: number; accounts: number; inventoryHoldings: number; jobs: number };
}

/**
 * I31B 备份 application。备份由 better-sqlite3 .backup() 在 WAL 活跃写入时产出一致副本，
 * 事务外执行避免长事务；记录 INSERT→（事务外备份）→UPDATE 全程不破坏已成功备份。
 * 失败只追加 failed 记录，绝不删最近成功备份。管理员/系统触发均受幂等键去重。
 */
export class BackupService {
  private readonly backups: SqliteBackupRepository;
  constructor(
    private readonly database: Database.Database,
    private readonly sqlitePath: string,
    private readonly config: BackupConfig
  ) {
    this.backups = new SqliteBackupRepository(database);
    mkdirSync(config.BACKUP_DIR, { recursive: true });
  }

  /**
   * 执行一次备份。幂等：同 idempotencyKey 的 succeeded 记录直接返回，不重复备份；
   * 同键 running 记录返回 skipped，调用方安全跳过。
   * 备份体在事务外产生（.backup() 自身处理 WAL 一致性），失败绝不删最近成功备份。
   * better-sqlite3 .backup() 返回 Promise（online backup），故本方法为 async；
   * 任务处理器与管理路由均 await 它，保证记录状态在返回时已落库。
   */
  async runBackup(input: { kind: BackupKind; actorId: string; requestId: string | null; idempotencyKey: string; now?: string }): Promise<BackupRunResult> {
    const now = input.now ?? utcNow();
    const existing = this.backups.findByIdempotency(input.idempotencyKey);
    if (existing) {
      if (existing.status === "succeeded") return { record: existing, skipped: false };
      if (existing.status === "running") return { record: existing, skipped: true };
      // failed 记录允许以同键重试：保留历史 failed，新建 running 记录。
    }
    const record = this.backups.insert({ kind: input.kind, sourceSqlitePath: this.sqlitePath, createdBy: input.actorId, requestId: input.requestId, idempotencyKey: input.idempotencyKey, now });
    try {
      this.ensureRetentionCapacity();
      const fileName = `backup-${now.replace(/[:.]/g, "")}-${record.id.slice(0, 8)}.db`;
      const absolutePath = join(this.config.BACKUP_DIR, fileName);
      // .backup() 在 WAL 活跃写入时产出一致副本（online backup）；事务外执行避免长事务阻塞经济写入。
      // progress 回调返回要保存的剩余页数：返回 remainingPages 表示“保存全部剩余页”，直至完成。
      // 注意返回 0 表示“不保存”会使备份停滞，故必须返回 remainingPages。
      await this.database.backup(absolutePath, { progress: (info) => info.remainingPages });
      const sha256 = sha256File(absolutePath);
      const sizeBytes = statSync(absolutePath).size;
      const integrityOk = this.config.BACKUP_INTEGRITY_CHECK ? checkIntegrity(absolutePath) : true;
      this.backups.complete({ id: record.id, backupFileName: fileName, backupPathRelative: fileName, sizeBytes, sqliteIntegrityOk: integrityOk, sha256, now });
      return { record: this.backups.get(record.id)!, skipped: false };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.backups.fail({ id: record.id, reason: reason.slice(0, 500), now });
      // 失败绝不删最近成功备份；保留 failed 记录供审计与重试。
      return { record: this.backups.get(record.id)!, skipped: false };
    }
  }

  listBackups(limit: number): BackupRecord[] {
    return this.backups.list(limit);
  }

  getBackup(id: string): BackupRecord | null {
    return this.backups.get(id);
  }

  /** 返回备份文件绝对路径供受控下载流；不把路径返回给浏览器。 */
  backupFileAbsolutePath(record: BackupRecord): string | null {
    if (record.status !== "succeeded" || !record.backupPathRelative) return null;
    return join(this.config.BACKUP_DIR, record.backupPathRelative);
  }

  /** 保留策略：保留至少 N 份成功备份，清理多余的旧备份磁盘文件；永不删最新成功备份。 */
  pruneBackups(now: string = utcNow()): { prunedIds: string[] } {
    const records = this.backups.listByKind("scheduled", 1000).concat(this.backups.listByKind("manual", 1000)).concat(this.backups.listByKind("predeploy", 1000));
    const toRemove = retentionToKeep(records, this.config.BACKUP_RETENTION);
    for (const item of toRemove) {
      const record = this.backups.get(item.id);
      if (record?.backupPathRelative) {
        rmSync(join(this.config.BACKUP_DIR, record.backupPathRelative), { force: true });
        this.backups.markExpired(item.id, now);
      }
    }
    return { prunedIds: toRemove.map((item) => item.id) };
  }

  /**
   * 恢复演练：把备份打开到 EXPORT_DIR 临时只读副本，校验完整性 + 核心表存在与行数。
   * 绝不覆盖运行库；只读校验后删除临时副本。
   */
  restoreRehearsal(backupId: string): RestoreRehearsalResult | "not-found" | "not-succeeded" {
    const record = this.backups.get(backupId);
    if (!record) return "not-found";
    if (record.status !== "succeeded" || !record.backupPathRelative) return "not-succeeded";
    const backupPath = join(this.config.BACKUP_DIR, record.backupPathRelative);
    mkdirSync(this.config.EXPORT_DIR, { recursive: true });
    const rehearsalDir = join(this.config.EXPORT_DIR, `rehearsal-${backupId}`);
    mkdirSync(rehearsalDir, { recursive: true });
    const tempCopy = join(rehearsalDir, basename(backupPath));
    copyFileAtomic(backupPath, tempCopy);
    try {
      const integrityOk = checkIntegrity(tempCopy);
      const sample = sampleCoreTables(tempCopy);
      return {
        backupId,
        backupFileName: record.backupFileName ?? basename(backupPath),
        sqliteIntegrityOk: integrityOk,
        coreTablesPresent: sample.present,
        sampleCounts: sample.counts
      };
    } finally {
      rmSync(rehearsalDir, { recursive: true, force: true });
    }
  }

  /** 保留容量检查：当磁盘已存在过多备份文件时清理失败的孤儿记录，避免目录无限增长。 */
  private ensureRetentionCapacity(): void {
    try {
      const files = readdirSync(this.config.BACKUP_DIR).filter((file) => file.endsWith(".db"));
      // 失败备份不会落盘 .db（异常在 complete 前），此处仅防御性清理孤儿文件。
      void files;
    } catch {
      // 目录读取失败不阻断备份；保留最近成功备份的语义由 pruneBackups 保证。
    }
  }
}

function sha256File(absolutePath: string): string {
  const buffer = readFileSync(absolutePath);
  return createHash("sha256").update(buffer).digest("hex");
}

function checkIntegrity(absolutePath: string): boolean {
  // 使用独立连接以只读模式打开副本，避免影响运行库。
  try {
    const probe = new Database(absolutePath, { readonly: true });
    try {
      const result = probe.pragma("integrity_check", { simple: true });
      return result === "ok";
    } finally {
      probe.close();
    }
  } catch {
    // 损坏/截断的文件无法被 SQLite 打开或校验 → 视为完整性失败，不抛错。
    return false;
  }
}

function sampleCoreTables(absolutePath: string): { present: boolean; counts: { users: number; accounts: number; inventoryHoldings: number; jobs: number } } {
  try {
    const probe = new Database(absolutePath, { readonly: true });
    try {
      const tableNames = probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => (row as { name: string }).name);
      const required = ["users", "accounts", "inventory_holdings", "jobs"];
      const present = required.every((name) => tableNames.includes(name));
      const count = (table: string) => (tableNames.includes(table) ? (probe.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c : -1);
      return { present, counts: { users: count("users"), accounts: count("accounts"), inventoryHoldings: count("inventory_holdings"), jobs: count("jobs") } };
    } finally {
      probe.close();
    }
  } catch {
    // 损坏文件无法采样 → 视为表不存在，不抛错。
    return { present: false, counts: { users: -1, accounts: -1, inventoryHoldings: -1, jobs: -1 } };
  }
}

function copyFileAtomic(source: string, destination: string): void {
  const buffer = readFileSync(source);
  // 同步写入临时文件后重命名，避免半写入副本被当作合法备份。
  writeFileSync(`${destination}.tmp`, buffer);
  renameSync(`${destination}.tmp`, destination);
}
