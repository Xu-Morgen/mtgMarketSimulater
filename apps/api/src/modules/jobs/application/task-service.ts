import type { JobDto } from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";
import { errorSummary, retryDelayMs, registeredJobTypes, type JobHandler, type PersistedJob } from "../domain/job.js";
import { SqliteJobRepository } from "../infrastructure/sqlite-job-repository.js";

/** 业务模块经由 jobs application 投递重定价，不直接操作 jobs 表。 */
export function enqueueMarketRepriceJob(database: ConstructorParameters<typeof SqliteJobRepository>[0], triggerKey: string, now: string, priceSyncRunId?: string): void {
  new SqliteJobRepository(database).enqueue({ type: "market.reprice", payload: { triggerKey, ...(priceSyncRunId ? { priceSyncRunId } : {}) }, uniqueKey: triggerKey, runAfter: now, maxAttempts: 3 }, now);
}

/**
 * I17B 每日价格同步调度。以 UTC 自然日为唯一键：`last_scheduled_date` 落后于今日时
 * 投递一次 `prices.sync`（uniqueKey=`prices.sync:daily:<date>`）。停机多日只补投一次
 * 而非逐日补投——历史回填由独立的 `prices.backfill` 负责。条件 UPDATE + 任务唯一键
 * 保证补跑至多投递一次；daily.rollover 的发钱/赛事刷新按 AT-10B 延后至 I23B/I25B。
 */
export function ensureDailyPriceSyncScheduled(database: ConstructorParameters<typeof SqliteJobRepository>[0], now: Date): void {
  const iso = now.toISOString();
  const today = iso.slice(0, 10);
  withinTransaction(database, () => {
    const state = database.prepare("SELECT last_scheduled_date FROM price_sync_schedule_state WHERE singleton = 1").get() as { last_scheduled_date: string } | undefined;
    if (state && state.last_scheduled_date >= today) return;
    new SqliteJobRepository(database).enqueue({ type: "prices.sync", payload: {}, uniqueKey: `prices.sync:daily:${today}`, runAfter: iso, maxAttempts: 3 }, iso);
    database.prepare("UPDATE price_sync_schedule_state SET last_scheduled_date = ?, last_attempted_run_after = ?, updated_at = ? WHERE singleton = 1").run(today, iso, iso);
  });
}

export class TaskRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  constructor() {
    // I05 先冻结任务类型和调度契约；后续业务迭代以应用用例替换这些安全的空处理器。
    for (const type of registeredJobTypes) this.handlers.set(type, () => undefined);
  }

  register(type: PersistedJob["type"], handler: JobHandler): void { this.handlers.set(type, handler); }
  get(type: PersistedJob["type"]): JobHandler { return this.handlers.get(type)!; }
}

export function toJobDto(job: PersistedJob): JobDto {
  return { id: job.id, type: job.type, status: job.status, attempt: job.attempts, maxAttempts: job.maxAttempts, uniqueKey: job.uniqueKey, scheduledAt: job.runAfter, lockedUntil: job.lockedUntil, lastError: job.lastError, updatedAt: job.updatedAt };
}

export class TaskWorker {
  /** Bulk 导入和系列卡图下载均可能超过短轮询周期；租约须覆盖受控外部 I/O 的正常时长。 */
  constructor(private readonly repository: SqliteJobRepository, private readonly registry: TaskRegistry, private readonly now: () => Date = () => new Date(), private readonly leaseMs = 10 * 60_000) {}

  recover(): void { this.repository.recoverExpired(this.now().toISOString()); }

  async runOne(): Promise<boolean> {
    const started = this.now();
    const job = this.repository.claim(started.toISOString(), new Date(started.getTime() + this.leaseMs).toISOString());
    if (!job) return false;
    try {
      await this.registry.get(job.type)(JSON.parse(job.payloadJson), { jobId: job.id, attempt: job.attempts });
      this.repository.succeed(job, this.now().toISOString());
    } catch (error) {
      const now = this.now();
      this.repository.fail(job, errorSummary(error), new Date(now.getTime() + retryDelayMs(job.attempts)).toISOString(), now.toISOString());
    }
    return true;
  }
}
