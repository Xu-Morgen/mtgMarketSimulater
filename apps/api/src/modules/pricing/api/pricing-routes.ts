import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PriceSyncBackfillResultDto, PriceSyncRunDto, PriceSyncStatusDto, PublicPriceStatusDto } from "@mtg-market/contracts";
import type { ApiConfig } from "../../../config/environment.js";
import { MtgjsonClient } from "../../../platform/external/mtgjson/mtgjson-client.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { toJobDto } from "../../jobs/application/task-service.js";
import { SqliteJobRepository } from "../../jobs/infrastructure/sqlite-job-repository.js";
import { type PriceSyncLogger, PriceSyncService } from "../application/price-sync-service.js";
import { type PriceBackfillLogger, PriceBackfillService } from "../application/price-backfill-service.js";

const syncBodySchema = z.object({ expectedPricesChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), expectedMappingChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), allowChecksumMismatch: z.literal(true).optional() }).strict();
const backfillBodySchema = z.object({ expectedPricesChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), allowChecksumMismatch: z.literal(true).optional() }).strict();

/** I17B：价格数据源与资产性质说明；浏览器只展示，不自行拼接或改写。 */
const PRICE_DATA_DISCLAIMER = "外部参考价来自 MTGJSON / Cardmarket EUR 快照，游戏内价为虚拟货币 GAME_CREDIT；均为非实时、非真实资产，仅供本模拟器使用。";

type Run = NonNullable<ReturnType<PriceSyncService["status"]>["current"]>;
function toDto(run: Run): PriceSyncRunDto { return { id: run.id, sourceVersion: run.source_version, pricesChecksumSha256: run.prices_checksum_sha256, mappingChecksumSha256: run.mapping_checksum_sha256, status: run.status, checksumVerification: run.checksum_verification, runKind: "daily", mappedSkus: run.mapped_skus, pricedSkus: run.priced_skus, unpricedSkus: run.unpriced_skus, mappingFailedSkus: run.mapping_failed_skus, failureCode: run.failure_code, failureReason: run.failure_reason, startedAt: run.started_at, completedAt: run.completed_at }; }
function publicStatus(status: ReturnType<PriceSyncService["status"]>): PublicPriceStatusDto {
  if (!status.latestSuccessful) return { source: null, updatedAt: null, freshness: "unavailable", disclaimer: PRICE_DATA_DISCLAIMER };
  return {
    source: "mtgjson-cardmarket",
    updatedAt: status.latestSuccessful.completed_at ?? status.latestSuccessful.started_at,
    // 新一次同步失败时，继续展示最近成功快照，但明确不把它当作当前数据。
    freshness: status.current?.status === "failed" ? "stale" : "fresh",
    disclaimer: PRICE_DATA_DISCLAIMER
  };
}
function checksumBypassAvailable(status: ReturnType<PriceSyncService["status"]>): boolean { return status.current?.status === "failed" && status.current.failure_code === "CHECKSUM_MISMATCH"; }

export function createPriceSyncService(config: ApiConfig, database: Database.Database, logger?: PriceSyncLogger): PriceSyncService { return new PriceSyncService(database, new MtgjsonClient(config.MTGJSON_PRICES_ENDPOINT, config.MTGJSON_PRINTINGS_ENDPOINT, config.MTGJSON_USER_AGENT, fetch, config.MTGJSON_ALLPRICES_ENDPOINT), logger); }
export function createPriceBackfillService(config: ApiConfig, database: Database.Database, logger?: PriceBackfillLogger): PriceBackfillService { return new PriceBackfillService(database, new MtgjsonClient(config.MTGJSON_PRICES_ENDPOINT, config.MTGJSON_PRINTINGS_ENDPOINT, config.MTGJSON_USER_AGENT, fetch, config.MTGJSON_ALLPRICES_ENDPOINT), logger); }

export async function registerPricingRoutes(app: FastifyInstance, config: ApiConfig, database: Database.Database): Promise<void> {
  const sync = createPriceSyncService(config, database);
  const backfill = createPriceBackfillService(config, database);
  app.get("/v1/prices/status", { preHandler: requireRole("player") }, async (request) => success(request.requestId, publicStatus(sync.status())));
  app.get("/v1/admin/prices/sync", { preHandler: requireRole("admin") }, async (request) => {
    const status = sync.status(); const currentJob = new SqliteJobRepository(database).list(undefined, 100).find((job) => job.type === "prices.sync") ?? null;
    const result: PriceSyncStatusDto = { latestSuccessful: status.latestSuccessful ? toDto(status.latestSuccessful) : null, current: status.current ? toDto(status.current) : null, currentJob: currentJob ? toJobDto(currentJob) : null, checksumBypassAvailable: checksumBypassAvailable(status) };
    return success(request.requestId, result);
  });
  app.post("/v1/admin/prices/sync", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = request.headers["idempotency-key"]; if (typeof key !== "string" || key.length < 8) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带 Idempotency-Key"));
    const payload = syncBodySchema.parse(request.body ?? {});
    if (payload.allowChecksumMismatch && !checksumBypassAvailable(sync.status())) return reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", "仅可在最近一次价格同步因 checksum 不匹配失败后覆写"));
    const now = new Date().toISOString(); const job = new SqliteJobRepository(database).enqueue({ type: "prices.sync", payload, uniqueKey: `prices.sync:${key}`, runAfter: now, maxAttempts: 3 }, now);
    if (payload.allowChecksumMismatch) {
      database.prepare("INSERT OR IGNORE INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'price_sync.checksum_bypass_requested', 'job', ?, ?, ?, ?)").run(randomUUID(), request.actor!.id, job.id, request.requestId, JSON.stringify({ taskType: job.type, checksumVerification: "bypassed" }), now);
    }
    return reply.code(201).send(success(request.requestId, toJobDto(job)));
  });
  app.get("/v1/admin/prices/backfill", { preHandler: requireRole("admin") }, async (request) => {
    const status = backfill.status(); const currentJob = new SqliteJobRepository(database).list(undefined, 100).find((job) => job.type === "prices.backfill") ?? null;
    const latest = status.latestRun;
    const result: PriceSyncBackfillResultDto = latest
      ? { latestRun: { id: latest.id, sourceVersion: latest.sourceVersion, pricesChecksumSha256: latest.pricesChecksumSha256, mappingChecksumSha256: "not-applicable", status: latest.status, checksumVerification: latest.checksumVerification, runKind: "backfill", mappedSkus: 0, pricedSkus: latest.insertedEntries, unpricedSkus: latest.skippedExistingEntries, mappingFailedSkus: 0, failureCode: latest.failureCode === "CHECKSUM_MISMATCH" ? "CHECKSUM_MISMATCH" : null, failureReason: latest.failureReason, startedAt: latest.startedAt, completedAt: latest.completedAt }, backfilledFromDate: latest.backfilledFromDate, backfilledToDate: latest.backfilledToDate, insertedEntries: latest.insertedEntries, skippedExistingEntries: latest.skippedExistingEntries, currentJob: currentJob ? toJobDto(currentJob) : null }
      : { latestRun: null, backfilledFromDate: null, backfilledToDate: null, insertedEntries: 0, skippedExistingEntries: 0, currentJob: currentJob ? toJobDto(currentJob) : null };
    return success(request.requestId, result);
  });
  app.post("/v1/admin/prices/backfill", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = request.headers["idempotency-key"]; if (typeof key !== "string" || key.length < 8) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带 Idempotency-Key"));
    const payload = backfillBodySchema.parse(request.body ?? {});
    const now = new Date().toISOString(); const job = new SqliteJobRepository(database).enqueue({ type: "prices.backfill", payload, uniqueKey: `prices.backfill:${key}`, runAfter: now, maxAttempts: 3 }, now);
    database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'price_backfill.requested', 'job', ?, ?, ?, ?)").run(randomUUID(), request.actor!.id, job.id, request.requestId, JSON.stringify({ taskType: job.type, expectedPricesChecksumSha256: payload.expectedPricesChecksumSha256 ?? null, allowChecksumMismatch: payload.allowChecksumMismatch === true }), now);
    return reply.code(201).send(success(request.requestId, toJobDto(job)));
  });
}
