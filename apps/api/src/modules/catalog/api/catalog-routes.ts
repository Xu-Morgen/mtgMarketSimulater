import type Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiConfig } from "../../../config/environment.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { requireRole } from "../../auth/api/auth-routes.js";
import { CatalogService } from "../application/catalog-service.js";
import type { CatalogImageCacheRequest } from "../application/catalog-image-cache-service.js";
import { CatalogSyncService } from "../application/catalog-sync-service.js";
import { SqliteCatalogRepository } from "../infrastructure/sqlite-catalog-repository.js";
import { ScryfallBulkClient } from "../../../platform/external/scryfall/scryfall-bulk-client.js";
import { SqliteJobRepository } from "../../jobs/infrastructure/sqlite-job-repository.js";
import { toJobDto } from "../../jobs/application/task-service.js";
import type { CatalogSyncRunDto, CatalogSyncStatusDto } from "@mtg-market/contracts";

const listQuerySchema = z.object({
  query: z.string().trim().min(1).max(120).optional(), setCode: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()).optional(),
  rarity: z.string().trim().min(1).max(40).optional(), finish: z.enum(["nonfoil", "foil", "etched"]).optional(),
  cursor: z.string().regex(/^\d+$/).optional(), limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();
const skuParamsSchema = z.object({ skuId: z.string().uuid() }).strict();
const imageParamsSchema = z.object({ imageName: z.string().regex(/^[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$/i) }).strict();
const syncBodySchema = z.object({ expectedChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict();
const imageCacheBodySchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("single"), skuId: z.string().uuid() }).strict(),
  z.object({ scope: z.literal("set"), setCode: z.string().trim().min(1).max(20).transform((value) => value.toUpperCase()) }).strict()
]);

function toSyncRunDto(run: NonNullable<ReturnType<CatalogSyncService["status"]>["current"]>): CatalogSyncRunDto {
  let enabledSetCodes: string[] = []; let diff: CatalogSyncRunDto["diff"] = {};
  try { enabledSetCodes = JSON.parse(run.enabled_sets_json) as string[]; } catch { /* 损坏历史仍可安全展示其余状态。 */ }
  try { diff = JSON.parse(run.diff_json) as CatalogSyncRunDto["diff"]; } catch { /* 同上。 */ }
  return { id: run.id, sourceVersion: run.source_version, checksumSha256: run.checksum_sha256, enabledSetCodes, status: run.status, importedPrintings: run.imported_printings, importedSkus: run.imported_skus, cachedImages: run.cached_images, diff, failureReason: run.failure_reason, startedAt: run.started_at, completedAt: run.completed_at };
}

/** 浏览器只能读取本地目录；I09 前没有任何外部 Provider 访问路径。 */
export function createCatalogSyncService(config: ApiConfig, database: Database.Database): CatalogSyncService {
  return new CatalogSyncService(database, new ScryfallBulkClient(config.SCRYFALL_BULK_ENDPOINT, config.SCRYFALL_USER_AGENT), config.CATALOG_ENABLED_SET_CODES);
}

export async function registerCatalogRoutes(app: FastifyInstance, config: ApiConfig, database: Database.Database): Promise<void> {
  const catalog = new CatalogService(new SqliteCatalogRepository(database));
  const sync = createCatalogSyncService(config, database);
  app.get("/v1/catalog/cards", { preHandler: requireRole("player") }, async (request) => success(request.requestId, catalog.list(listQuerySchema.parse(request.query))));
  app.get("/v1/catalog/cards/:skuId", { preHandler: requireRole("player") }, async (request, reply) => {
    const result = catalog.detail(skuParamsSchema.parse(request.params).skuId);
    return result ? success(request.requestId, { sku: result }) : reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "卡牌 SKU 不存在"));
  });

  /** 本地受控静态路径：只接受服务端生成的文件名，目录浏览和任意磁盘路径均被拒绝。 */
  app.get("/v1/catalog/images/:imageName", { preHandler: requireRole("player") }, async (request, reply) => {
    const { imageName } = imageParamsSchema.parse(request.params);
    const root = resolve(config.CATALOG_DATA_DIR, "images"); const target = resolve(root, imageName);
    if (!target.startsWith(`${root}${sep}`)) return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "图片不存在"));
    try {
      const bytes = await readFile(target); reply.header("Cache-Control", "private, max-age=86400"); reply.type(imageName.endsWith(".png") ? "image/png" : imageName.endsWith(".webp") ? "image/webp" : "image/jpeg"); return bytes;
    } catch { return reply.code(404).send(failure(request.requestId, "RESOURCE_NOT_FOUND", "图片不存在")); }
  });

  app.get("/v1/admin/catalog/sync", { preHandler: requireRole("admin") }, async (request) => {
    const status = sync.status();
    const jobs = new SqliteJobRepository(database).list(undefined, 100);
    const currentJob = jobs.find((job) => job.type === "catalog.sync") ?? null;
    const currentImageCacheJob = jobs.find((job) => job.type === "catalog.image-cache") ?? null;
    const result: CatalogSyncStatusDto = { latestSuccessful: status.latestSuccessful ? toSyncRunDto({ ...status.latestSuccessful, status: "succeeded" }) : null, current: status.current ? toSyncRunDto(status.current) : null, currentJob: currentJob ? toJobDto(currentJob) : null, currentImageCacheJob: currentImageCacheJob ? toJobDto(currentImageCacheJob) : null };
    return success(request.requestId, result);
  });
  app.post("/v1/admin/catalog/sync", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带 Idempotency-Key"));
    const payload = syncBodySchema.parse(request.body ?? {});
    const job = new SqliteJobRepository(database).enqueue({ type: "catalog.sync", payload, uniqueKey: `catalog.sync:${key}`, runAfter: new Date().toISOString(), maxAttempts: 3 }, new Date().toISOString());
    return reply.code(201).send(success(request.requestId, toJobDto(job)));
  });
  app.post("/v1/admin/catalog/image-cache", { preHandler: requireRole("admin") }, async (request, reply) => {
    const key = request.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8) return reply.code(400).send(failure(request.requestId, "IDEMPOTENCY_KEY_REQUIRED", "写请求必须携带 Idempotency-Key"));
    const payload = imageCacheBodySchema.parse(request.body ?? {}) as CatalogImageCacheRequest;
    const job = new SqliteJobRepository(database).enqueue({ type: "catalog.image-cache", payload, uniqueKey: `catalog.image-cache:${key}`, runAfter: new Date().toISOString(), maxAttempts: 3 }, new Date().toISOString());
    return reply.code(201).send(success(request.requestId, toJobDto(job)));
  });
}
