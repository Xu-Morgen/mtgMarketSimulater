import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PriceSyncRunDto, PriceSyncStatusDto } from "@mtg-market/contracts";
import type { ApiConfig } from "../../../config/environment.js";
import { MtgjsonClient } from "../../../platform/external/mtgjson/mtgjson-client.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { toJobDto } from "../../jobs/application/task-service.js";
import { SqliteJobRepository } from "../../jobs/infrastructure/sqlite-job-repository.js";
import { PriceSyncService } from "../application/price-sync-service.js";

const syncBodySchema = z.object({ expectedPricesChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(), expectedMappingChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict();

type Run = NonNullable<ReturnType<PriceSyncService["status"]>["current"]>;
function toDto(run: Run): PriceSyncRunDto { return { id: run.id, sourceVersion: run.source_version, pricesChecksumSha256: run.prices_checksum_sha256, mappingChecksumSha256: run.mapping_checksum_sha256, status: run.status, mappedSkus: run.mapped_skus, pricedSkus: run.priced_skus, unpricedSkus: run.unpriced_skus, mappingFailedSkus: run.mapping_failed_skus, failureReason: run.failure_reason, startedAt: run.started_at, completedAt: run.completed_at }; }

export function createPriceSyncService(config: ApiConfig, database: Database.Database): PriceSyncService { return new PriceSyncService(database, new MtgjsonClient(config.MTGJSON_PRICES_ENDPOINT, config.MTGJSON_PRINTINGS_ENDPOINT, config.MTGJSON_USER_AGENT)); }

export async function registerPricingRoutes(app: FastifyInstance, config: ApiConfig, database: Database.Database): Promise<void> {
  const sync = createPriceSyncService(config, database);
  app.get("/v1/admin/prices/sync", { preHandler: requireRole("admin") }, async (request) => {
    const status = sync.status(); const currentJob = new SqliteJobRepository(database).list(undefined, 100).find((job) => job.type === "prices.sync") ?? null;
    const result: PriceSyncStatusDto = { latestSuccessful: status.latestSuccessful ? toDto(status.latestSuccessful) : null, current: status.current ? toDto(status.current) : null, currentJob: currentJob ? toJobDto(currentJob) : null };
    return success(request.requestId, result);
  });
  app.post("/v1/admin/prices/sync", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = request.headers["idempotency-key"]; if (typeof key !== "string" || key.length < 8) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带 Idempotency-Key"));
    const payload = syncBodySchema.parse(request.body ?? {}); const now = new Date().toISOString(); const job = new SqliteJobRepository(database).enqueue({ type: "prices.sync", payload, uniqueKey: `prices.sync:${key}`, runAfter: now, maxAttempts: 3 }, now);
    return reply.code(201).send(success(request.requestId, toJobDto(job)));
  });
}
