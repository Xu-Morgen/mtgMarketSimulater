import type { JobDto } from "@mtg-market/contracts";
import { errorSummary, retryDelayMs, registeredJobTypes, type JobHandler, type PersistedJob } from "../domain/job.js";
import type { SqliteJobRepository } from "../infrastructure/sqlite-job-repository.js";

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
  constructor(private readonly repository: SqliteJobRepository, private readonly registry: TaskRegistry, private readonly now: () => Date = () => new Date(), private readonly leaseMs = 30_000) {}

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
