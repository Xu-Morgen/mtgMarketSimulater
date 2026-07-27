import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { withinTransaction } from "@mtg-market/database";
import {
  MtgjsonChecksumMismatchError,
  type MtgjsonAllPricesSource,
  type MtgjsonChecksumFile,
  type MtgjsonClient,
  type MtgjsonHistoricalPrice
} from "../../../platform/external/mtgjson/mtgjson-client.js";

type BackfillPayload = { expectedPricesChecksumSha256?: string; allowChecksumMismatch?: boolean };
type CatalogMapping = { sku_id: string; mtgjson_uuid: string; finish: "nonfoil" | "foil" | "etched" };
type ExistingDateRow = { sku_id: string; captured_day: string };

/** 回填监督运行的脱敏统计；日期范围为 UTC YYYY-MM-DD，null 表示尚未成功回填。 */
export type PriceBackfillRunSummary = {
  id: string;
  sourceVersion: string;
  pricesChecksumSha256: string;
  status: "running" | "succeeded" | "failed";
  checksumVerification: "verified" | "bypassed" | "not_verified";
  failureCode: string | null;
  failureReason: string | null;
  startedAt: string;
  completedAt: string | null;
  /** 复用 priced_skus 列记录本次实际新增的历史快照条数。 */
  insertedEntries: number;
  /** 复用 unpriced_skus 列记录因已有同日快照而跳过的条数。 */
  skippedExistingEntries: number;
  backfilledFromDate: string | null;
  backfilledToDate: string | null;
};

export type PriceBackfillStatus = { latestRun: PriceBackfillRunSummary | null };
export type PriceBackfillExecutionContext = { jobId?: string; attempt?: number };
export type PriceBackfillLogger = { error: (bindings: Record<string, unknown>, message: string) => void; info?: (bindings: Record<string, unknown>, message: string) => void };

type BackfillStage = "download_or_parse" | "expected_checksum" | "persist";
type BackfillFailureDetail = { stage: "provider_checksum" | "expected_checksum" | BackfillStage; file: MtgjsonChecksumFile | null; expectedChecksumSha256: string | null; actualChecksumSha256: string | null };

class ExpectedChecksumMismatchError extends Error {
  constructor(readonly file: MtgjsonChecksumFile, readonly expectedChecksumSha256: string, readonly actualChecksumSha256: string) { super(`MTGJSON ${file} checksum 与管理员指定版本不匹配`); this.name = "ExpectedChecksumMismatchError"; }
}

const silentLogger: PriceBackfillLogger = { error: () => undefined };

function cents(value: number): number { const result = Math.round((value + Number.EPSILON) * 100); if (!Number.isSafeInteger(result) || result <= 0) throw new Error("Cardmarket EUR 历史价格必须是正的安全欧分整数"); return result; }

/**
 * I17B 一次性 AllPrices 历史回填。它只追加本地缺失的历史日期外部快照，绝不覆盖
 * 已有每日同步写入的快照、移动 `price_sync_state` 最近成功指针或为每个历史日期投递
 * `market.reprice`。整个解析、校验与写入在一笔短事务内完成；事务中断不留半批次。
 */
export class PriceBackfillService {
  constructor(private readonly database: Database.Database, private readonly client: MtgjsonClient, private readonly logger: PriceBackfillLogger = silentLogger) {}

  status(): PriceBackfillStatus {
    const row = this.database.prepare(
      `SELECT id, source_version, prices_checksum_sha256, status, checksum_verification, failure_code, failure_reason,
        priced_skus AS inserted_entries, unpriced_skus AS skipped_existing_entries, started_at, completed_at
       FROM price_sync_runs WHERE run_kind = 'backfill' AND mapping_uri = 'supervisor'
       ORDER BY started_at DESC, rowid DESC LIMIT 1`
    ).get() as
      | {
          id: string;
          source_version: string;
          prices_checksum_sha256: string;
          status: "running" | "succeeded" | "failed";
          checksum_verification: "verified" | "bypassed" | "not_verified";
          failure_code: string | null;
          failure_reason: string | null;
          inserted_entries: number;
          skipped_existing_entries: number;
          started_at: string;
          completed_at: string | null;
        }
      | undefined;
    if (!row) return { latestRun: null };
    // 成功回填的 supervisor source_version 形如 "<version>:<fromDate>:<toDate>"；失败运行保留原始 version。
    const segments = row.source_version.split(":");
    const fromDate = segments.length >= 3 ? segments[segments.length - 2]! : null;
    const toDate = segments.length >= 3 ? segments[segments.length - 1]! : null;
    return {
      latestRun: {
        id: row.id,
        sourceVersion: row.source_version,
        pricesChecksumSha256: row.prices_checksum_sha256,
        status: row.status,
        checksumVerification: row.checksum_verification,
        failureCode: row.failure_code,
        failureReason: row.failure_reason,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        insertedEntries: row.inserted_entries,
        skippedExistingEntries: row.skipped_existing_entries,
        backfilledFromDate: fromDate,
        backfilledToDate: toDate
      }
    };
  }

  async backfill(payload: BackfillPayload = {}, context: PriceBackfillExecutionContext = {}): Promise<void> {
    const startedAt = new Date().toISOString();
    const supervisorRunId = randomUUID();
    let source: MtgjsonAllPricesSource | null = null;
    let stage: BackfillStage = "download_or_parse";
    try {
      source = await this.client.downloadAllPrices({ allowChecksumMismatch: payload.allowChecksumMismatch === true });
      stage = "expected_checksum";
      if (payload.expectedPricesChecksumSha256 && payload.expectedPricesChecksumSha256 !== source.pricesChecksumSha256) throw new ExpectedChecksumMismatchError("AllPrices", payload.expectedPricesChecksumSha256, source.pricesChecksumSha256);
      stage = "persist";
      const result = withinTransaction(this.database, () => this.appendHistoricalSnapshots(supervisorRunId, source!, startedAt));
      this.logger.info?.({ event: "price_backfill.completed", supervisorRunId, jobId: context.jobId ?? null, attempt: context.attempt ?? null, inserted: result.inserted, skipped: result.skipped, fromDate: result.fromDate, toDate: result.toDate }, "MTGJSON 历史价格回填完成");
    } catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const failureCode = error instanceof MtgjsonChecksumMismatchError ? error.code : null;
      const validation = failureDetail(error, stage);
      this.logger.error({
        event: validation.stage === "persist" ? "price_backfill.failed" : "price_backfill.validation_failed",
        supervisorRunId, jobId: context.jobId ?? null, attempt: context.attempt ?? null, sourceVersion: source?.version ?? null, validation, errorName: error instanceof Error ? error.name : "UnknownError", errorMessage: reason
      }, "MTGJSON 历史价格回填失败");
      this.database.prepare(
        "INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, run_kind, priced_skus, unpriced_skus, failure_code, failure_reason, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', ?, ?, 'supervisor', ?, 'not-applicable', 'failed', 'not_verified', 'backfill', 0, 0, ?, ?, ?, ?)"
      ).run(supervisorRunId, source?.version ?? "unavailable", source?.pricesUri ?? "unavailable", source?.pricesChecksumSha256 ?? "unavailable", failureCode, reason, startedAt, new Date().toISOString());
      throw error;
    }
  }

  /**
   * 回填为每个历史日期创建一个独立的 backfill 子运行，复用 UNIQUE(sync_run_id, sku_id)
   * 约束；监督运行（mapping_uri='supervisor'）汇总统计与日期范围。已存在的 (sku_id, 自然日)
   * 被跳过而不覆盖。绝不更新 `price_sync_state`、`price_sync_schedule_state` 或投递 `market.reprice`。
   */
  private appendHistoricalSnapshots(supervisorRunId: string, source: MtgjsonAllPricesSource, now: string) {
    // 监督运行先以 running 写入；统计在最后更新。source_version 末尾保留日期范围供 status() 读取。
    this.database.prepare(
      "INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, run_kind, priced_skus, unpriced_skus, started_at) VALUES (?, 'mtgjson-cardmarket', ?, ?, 'supervisor', ?, 'not-applicable', 'running', ?, 'backfill', 0, 0, ?)"
    ).run(supervisorRunId, source.version, source.pricesUri, source.pricesChecksumSha256, source.checksumVerification, now);

    // 取每 SKU 最新成功映射；映射缺失的 SKU 不参与回填（不改变其 tradable 状态）。
    const mappings = this.database.prepare(
      `SELECT m.sku_id, m.mtgjson_uuid, m.finish FROM price_sku_mappings m
       WHERE m.created_at = (SELECT MAX(latest.created_at) FROM price_sku_mappings latest WHERE latest.sku_id = m.sku_id)`
    ).all() as CatalogMapping[];

    // 已有外部快照覆盖的 (sku_id, 自然日) 集合；回填只补缺失日期，绝不覆盖每日同步写入。
    const existing = new Set<string>();
    const existingRows = this.database.prepare(
      "SELECT sku_id, substr(captured_at, 1, 10) AS captured_day FROM price_snapshot_entries WHERE availability = 'priced'"
    ).all() as ExistingDateRow[];
    for (const row of existingRows) existing.add(`${row.sku_id}:${row.captured_day}`);

    // 按历史日期聚合待写入条目，每日期一个独立 backfill 子运行。
    const byDate = new Map<string, Array<{ mapping: CatalogMapping; price: MtgjsonHistoricalPrice }>>();
    let skipped = 0;
    for (const mapping of mappings) {
      const priceType = mapping.finish === "nonfoil" ? "normal" : mapping.finish;
      const history = source.prices.get(`${mapping.mtgjson_uuid}:${priceType}`) ?? [];
      for (const price of history) {
        if (existing.has(`${mapping.sku_id}:${price.date}`)) { skipped += 1; continue; }
        const bucket = byDate.get(price.date) ?? [];
        bucket.push({ mapping, price });
        byDate.set(price.date, bucket);
      }
    }

    const insertEntry = this.database.prepare(
      "INSERT INTO price_snapshot_entries (id, sync_run_id, sku_id, mapping_id, mtgjson_uuid, finish, price_type, currency, price_amount, availability, unavailable_reason, captured_at, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, 'priced', NULL, ?, ?)"
    );
    const insertSubRun = this.database.prepare(
      "INSERT INTO price_sync_runs (id, source, source_version, prices_uri, mapping_uri, prices_checksum_sha256, mapping_checksum_sha256, status, checksum_verification, run_kind, priced_skus, started_at, completed_at) VALUES (?, 'mtgjson-cardmarket', ?, ?, 'sub-run', ?, 'not-applicable', 'succeeded', ?, 'backfill', ?, ?, ?)"
    );
    let inserted = 0;
    let fromDate: string | null = null;
    let toDate: string | null = null;
    const sortedDates = [...byDate.keys()].sort();
    for (const date of sortedDates) {
      const subRunId = randomUUID();
      const capturedAt = `${date}T00:00:00.000Z`;
      insertSubRun.run(subRunId, `${source.version}:${date}`, source.pricesUri, source.pricesChecksumSha256, source.checksumVerification, byDate.get(date)!.length, capturedAt, now);
      for (const { mapping, price } of byDate.get(date)!) {
        const priceType = mapping.finish === "nonfoil" ? "normal" : mapping.finish;
        insertEntry.run(randomUUID(), subRunId, mapping.sku_id, mapping.mtgjson_uuid, mapping.finish, priceType, price.currency, cents(price.amount), capturedAt, now);
        inserted += 1;
      }
      if (fromDate === null) fromDate = date;
      toDate = date;
    }

    const completedAt = new Date().toISOString();
    const rangeVersion = fromDate ? `${source.version}:${fromDate}:${toDate}` : source.version;
    this.database.prepare(
      "UPDATE price_sync_runs SET status = 'succeeded', source_version = ?, priced_skus = ?, unpriced_skus = ?, completed_at = ? WHERE id = ?"
    ).run(rangeVersion, inserted, skipped, completedAt, supervisorRunId);
    return { inserted, skipped, fromDate, toDate };
  }
}

function failureDetail(error: unknown, stage: BackfillStage): BackfillFailureDetail {
  if (error instanceof MtgjsonChecksumMismatchError) return { stage: "provider_checksum", file: error.file, expectedChecksumSha256: error.expectedChecksumSha256, actualChecksumSha256: error.actualChecksumSha256 };
  if (error instanceof ExpectedChecksumMismatchError) return { stage: "expected_checksum", file: error.file, expectedChecksumSha256: error.expectedChecksumSha256, actualChecksumSha256: error.actualChecksumSha256 };
  return { stage, file: null, expectedChecksumSha256: null, actualChecksumSha256: null };
}
