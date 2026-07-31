import { writeFileSync } from "node:fs";
import { mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { utcNow } from "@mtg-market/database";
import { stableColumnOrder, toCsv, type ExportReportKind } from "@mtg-market/rules";
import type { ExportConfig } from "../../../config/environment.js";
import type { ExportRecord } from "../domain/export-record.js";
import { SqliteExportRecordRepository } from "../infrastructure/sqlite-export-repository-records.js";
import { SqliteExportRepository } from "../infrastructure/sqlite-export-repository.js";

/** 所有导出子报表，按固定顺序生成；kind='all' 表示一次导出全部。 */
const ALL_REPORTS: ExportReportKind[] = ["holdings", "ledger", "npcTrades", "p2pOrders", "p2pTrades", "packOpenings", "tournaments"];

export interface GenerateExportInput {
  userId: string;
  requestId: string | null;
  idempotencyKey: string;
  formats: Array<"csv" | "json">;
  now?: string;
}

export interface GenerateExportResult {
  record: ExportRecord;
  skipped: boolean;
}

/**
 * I31B 导出 application。严格按 request 的玩家 userId 过滤数据（用户隔离），
 * 用 export-rules 生成稳定字段与防公式注入的 CSV；JSON 为只读快照。
 * 文件路径相对 EXPORT_DIR，下载时服务端再次复核 ownership 防越权。
 */
export class ExportService {
  private readonly reports: SqliteExportRepository;
  private readonly records: SqliteExportRecordRepository;
  constructor(private readonly database: Database.Database, private readonly config: ExportConfig) {
    this.reports = new SqliteExportRepository(database);
    this.records = new SqliteExportRecordRepository(database);
    mkdirSync(config.EXPORT_DIR, { recursive: true });
  }

  /** 生成玩家全部报表的 CSV/JSON。每种格式一个文件、一条记录。 */
  generate(input: GenerateExportInput): GenerateExportResult {
    const now = input.now ?? utcNow();
    const idempotencyKey = input.idempotencyKey;
    // 幂等：每格式独立幂等键后缀，使一次请求生成多条可重放记录。
    // 但同一 idempotencyKey 全局唯一（UNIQUE 约束），故每条记录用 `<key>:<format>`。
    const produced: ExportRecord[] = [];
    let firstSkipped = false;
    for (const format of input.formats) {
      const perFormatKey = `${idempotencyKey}:${format}`;
      const existing = this.records.findByIdempotency(perFormatKey);
      if (existing && (existing.status === "succeeded" || existing.status === "running")) {
        produced.push(existing);
        if (existing.status === "running") firstSkipped = true;
        continue;
      }
      const expiresAt = new Date(new Date(now).getTime() + this.config.EXPORT_TTL_SECONDS * 1000).toISOString();
      const fileName = `export-${input.userId.slice(0, 8)}-${now.replace(/[:.]/g, "")}-${format}.${format}`;
      const filePathRelative = fileName;
      const record = this.records.insert({ userId: input.userId, kind: "all", format, fileName, filePathRelative, expiresAt, requestId: input.requestId, idempotencyKey: perFormatKey, now });
      try {
        const content = this.serialize(input.userId, format);
        const absolutePath = join(this.config.EXPORT_DIR, filePathRelative);
        writeFileSync(absolutePath, content, "utf8");
        const sizeBytes = statSync(absolutePath).size;
        this.records.complete({ id: record.id, sizeBytes, now });
        produced.push(this.records.get(record.id)!);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.records.fail({ id: record.id, reason: reason.slice(0, 500), now });
        produced.push(this.records.get(record.id)!);
      }
    }
    // 返回首条记录作为代表（兼容单一记录契约）；formats 至少 1 项故 produced 非空。
    return { record: produced[0]!, skipped: firstSkipped };
  }

  listForUser(userId: string, limit: number): ExportRecord[] {
    return this.records.listByUser(userId, limit);
  }

  /**
   * 下载前复核 ownership：必须 user_id 匹配且 succeeded 且未过期。
   * 越权访问他人导出 id 返回 null（路由映射为 404，不泄露存在性）。
   */
  downloadableForUser(id: string, userId: string, now: string = utcNow()): ExportRecord | null {
    const record = this.records.getForUser(id, userId);
    if (!record) return null;
    if (record.status !== "succeeded") return null;
    if (record.expiresAt < now) {
      this.records.markExpired(id, now);
      return null;
    }
    return record;
  }

  absolutePath(record: ExportRecord): string {
    return join(this.config.EXPORT_DIR, record.filePathRelative);
  }

  /** 定时清理过期导出文件并标记记录。 */
  pruneExpired(now: string = utcNow()): { prunedIds: string[] } {
    const expired = this.records.listExpired(now, 500);
    for (const record of expired) {
      rmSync(join(this.config.EXPORT_DIR, record.filePathRelative), { force: true });
      this.records.markExpired(record.id, now);
    }
    return { prunedIds: expired.map((record) => record.id) };
  }

  /** 把指定格式的全部报表序列化为文件文本。CSV 多报表用空行分隔并带报表名标题；JSON 为对象。 */
  private serialize(userId: string, format: "csv" | "json"): string {
    const sections = ALL_REPORTS.map((kind) => ({ kind, rows: this.reports.readReport(userId, kind) }));
    if (format === "csv") {
      const parts = sections.map((section) => {
        const columns = stableColumnOrder(section.kind);
        const header = `# ${section.kind}`;
        const body = toCsv(section.rows as Array<Record<string, unknown>>, columns);
        return `${header}\n${body}`;
      });
      return parts.join("\n\n");
    }
    const json: Record<string, unknown> = { generatedAt: utcNow(), reports: {} };
    for (const section of sections) {
      json.reports = { ...(json.reports as Record<string, unknown>), [section.kind]: section.rows };
    }
    return JSON.stringify(json, null, 2);
  }
}
