import type Database from "better-sqlite3";
import { ensureDailyPriceSyncScheduled, ensureDailyRolloverScheduled, ensureDailyBackupScheduled, TaskRegistry, TaskWorker } from "./modules/jobs/application/task-service.js";
import { SqliteJobRepository } from "./modules/jobs/infrastructure/sqlite-job-repository.js";
import type { ApiConfig } from "./config/environment.js";
import { createCatalogSyncService } from "./modules/catalog/api/catalog-routes.js";
import { CatalogImageCacheService, type CatalogImageCacheRequest } from "./modules/catalog/application/catalog-image-cache-service.js";
import { CatalogImageCache } from "./platform/external/scryfall/scryfall-bulk-client.js";
import { createPriceSyncService, createPriceBackfillService } from "./modules/pricing/api/pricing-routes.js";
import type { PriceSyncLogger } from "./modules/pricing/application/price-sync-service.js";
import type { PriceBackfillLogger } from "./modules/pricing/application/price-backfill-service.js";
import { MarketService } from "./modules/market/application/market-service.js";
import { OrderService } from "./modules/orders/application/order-service.js";
import { DailyRolloverService, type DailyRolloverPayload } from "./modules/users/application/daily-rollover-service.js";
import { createTournamentService } from "./modules/tournaments/api/tournament-routes.js";
import { createAchievementService } from "./modules/achievements/api/achievement-routes.js";
import { BackupService } from "./modules/backup/application/backup-service.js";

export interface TaskRunner {
  stop(): Promise<void>;
}

/** 单进程串行调度器；SQLite 租约也使意外双实例只能条件领取一次。 */
export function startTaskRunner(database: Database.Database, intervalMs = 1_000, registry = new TaskRegistry(), now: () => Date = () => new Date(), dailyWorkFundingConfig?: Pick<ApiConfig, "APP_TIMEZONE" | "DAILY_WORK_FUNDING_RULE_VERSION">): TaskRunner {
  const worker = new TaskWorker(new SqliteJobRepository(database), registry);
  let stopping = false;
  let inFlight: Promise<void> | null = null;
  let lastDailyCheck = 0;

    const tick = () => {
    if (stopping || inFlight) return;
    // 日切检查以 5 分钟为节流，避免每秒查询；自然日唯一键保证补跑至多一次。
    const current = now().getTime();
    if (current - lastDailyCheck >= 5 * 60_000) {
      lastDailyCheck = current;
      const checkedAt = now();
      ensureDailyPriceSyncScheduled(database, checkedAt);
      ensureDailyBackupScheduled(database, checkedAt);
      if (dailyWorkFundingConfig) ensureDailyRolloverScheduled(database, { timezone: dailyWorkFundingConfig.APP_TIMEZONE, ruleVersion: dailyWorkFundingConfig.DAILY_WORK_FUNDING_RULE_VERSION }, checkedAt);
    }
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
  // I20B：到期回收委托（转 expired）或成交（转取消履约）。状态机条件 UPDATE 保证幂等与重复迁移防护。
  const orders = new OrderService(database);
  registry.register("order.expire", async (payload) => { orders.expireByPayload(payload); });
  const dailyRollover = new DailyRolloverService(database);
  const tournaments = createTournamentService(database, config);
  registry.register("daily.rollover", async (payload) => {
    const day = dailyRollover.rollover(payload as DailyRolloverPayload);
    tournaments.refreshDaily(day.natural_date, day.timezone);
  });
  registry.register("tournament.settle", async (payload) => {
    const parsed = payload as { registrationId?: string; playerTournamentId?: string };
    if (parsed.registrationId) {
      tournaments.settleRegistration(parsed.registrationId);
      return;
    }
    if (parsed.playerTournamentId) {
      tournaments.settleScheduledGameTournament(parsed.playerTournamentId);
      return;
    }
    throw new Error("赛事结算任务缺少报名或玩家赛事 ID");
  });
  // I26B：成就处理以独立任务消费 tournament.settled fact；解锁/奖励在 application 单事务内原子完成，重复 fact 幂等。
  const achievements = createAchievementService(database, config);
  registry.register("achievement.process", async (payload) => {
    const parsed = payload as { factEventId?: string };
    if (!parsed.factEventId) throw new Error("成就处理任务缺少 factEventId");
    achievements.processFactEvent({ factEventId: parsed.factEventId });
  });
  // I31B：备份在事务外产出 WAL 一致副本，失败只追加 failed 记录、绝不删最近成功备份。
  // payload.kind 可为 scheduled（每日）/predeploy（部署前）；scheduled 以 UTC 自然日唯一键去重。
  const backup = new BackupService(database, config.SQLITE_PATH, { BACKUP_DIR: config.BACKUP_DIR, BACKUP_RETENTION: config.BACKUP_RETENTION, BACKUP_INTEGRITY_CHECK: config.BACKUP_INTEGRITY_CHECK, EXPORT_DIR: config.EXPORT_DIR });
  registry.register("backup.create", async (payload) => {
    const parsed = (payload ?? {}) as { kind?: "scheduled" | "manual" | "predeploy" };
    await backup.runBackup({ kind: parsed.kind ?? "scheduled", actorId: "system", requestId: null, idempotencyKey: `backup.create:daily:${new Date().toISOString().slice(0, 10)}` });
    backup.pruneBackups();
  });
  return registry;
}
