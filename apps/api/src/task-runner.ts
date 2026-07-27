import type Database from "better-sqlite3";
import { ensureDailyPriceSyncScheduled, TaskRegistry, TaskWorker } from "./modules/jobs/application/task-service.js";
import { SqliteJobRepository } from "./modules/jobs/infrastructure/sqlite-job-repository.js";
import type { ApiConfig } from "./config/environment.js";
import { createCatalogSyncService } from "./modules/catalog/api/catalog-routes.js";
import { CatalogImageCacheService, type CatalogImageCacheRequest } from "./modules/catalog/application/catalog-image-cache-service.js";
import { CatalogImageCache } from "./platform/external/scryfall/scryfall-bulk-client.js";
import { createPriceSyncService, createPriceBackfillService } from "./modules/pricing/api/pricing-routes.js";
import type { PriceSyncLogger } from "./modules/pricing/application/price-sync-service.js";
import type { PriceBackfillLogger } from "./modules/pricing/application/price-backfill-service.js";
import { MarketService } from "./modules/market/application/market-service.js";

export interface TaskRunner {
  stop(): Promise<void>;
}

/** 单进程串行调度器；SQLite 租约也使意外双实例只能条件领取一次。 */
export function startTaskRunner(database: Database.Database, intervalMs = 1_000, registry = new TaskRegistry(), now: () => Date = () => new Date()): TaskRunner {
  const worker = new TaskWorker(new SqliteJobRepository(database), registry);
  let stopping = false;
  let inFlight: Promise<void> | null = null;
  let lastDailyCheck = 0;

  const tick = () => {
    if (stopping || inFlight) return;
    // 日切检查以 5 分钟为节流，避免每秒查询；自然日唯一键保证补跑至多一次。
    const current = now().getTime();
    if (current - lastDailyCheck >= 5 * 60_000) { lastDailyCheck = current; ensureDailyPriceSyncScheduled(database, now()); }
    inFlight = worker.runOne().then(() => undefined).finally(() => { inFlight = null; });
  };

  worker.recover();
  tick();
  const timer = setInterval(tick, intervalMs);
  return {
    async stop() {
      stopping = true;
      clearInterval(timer);
      await inFlight;
    }
  };
}

/** 业务处理器在应用层注册；jobs 模块只负责领取、重试与运行历史。 */
export function createTaskRegistry(config: ApiConfig, database: Database.Database, priceSyncLogger?: PriceSyncLogger, priceBackfillLogger?: PriceBackfillLogger): TaskRegistry {
  const registry = new TaskRegistry(); const catalog = createCatalogSyncService(config, database);
  const images = new CatalogImageCacheService(database, new CatalogImageCache(config.CATALOG_DATA_DIR, config.SCRYFALL_USER_AGENT));
  registry.register("catalog.sync", async (payload) => catalog.synchronize((payload ?? {}) as { expectedChecksumSha256?: string }));
  registry.register("catalog.image-cache", async (payload) => images.cache(payload as CatalogImageCacheRequest));
  const prices = createPriceSyncService(config, database, priceSyncLogger);
  registry.register("prices.sync", async (payload, context) => prices.synchronize((payload ?? {}) as { expectedPricesChecksumSha256?: string; expectedMappingChecksumSha256?: string; allowChecksumMismatch?: boolean }, context));
  const backfill = createPriceBackfillService(config, database, priceBackfillLogger);
  registry.register("prices.backfill", async (payload, context) => backfill.backfill((payload ?? {}) as { expectedPricesChecksumSha256?: string; allowChecksumMismatch?: boolean }, context));
  const market = new MarketService(database);
  registry.register("market.reprice", async (payload) => { market.reprice((payload ?? {}) as { priceSyncRunId?: string; triggerKey?: string }); });
  return registry;
}
