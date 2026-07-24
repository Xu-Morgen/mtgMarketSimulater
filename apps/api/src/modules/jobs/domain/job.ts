import type { JobStatus } from "@mtg-market/contracts";

export const registeredJobTypes = [
  "catalog.sync",
  "prices.sync",
  "daily.rollover",
  "market.reprice",
  "tournament.settle",
  "order.expire",
  "narrative.generate",
  "backup.create"
] as const;

export type RegisteredJobType = (typeof registeredJobTypes)[number];

export interface PersistedJob {
  id: string;
  type: RegisteredJobType;
  payloadJson: string;
  status: JobStatus;
  runAfter: string;
  attempts: number;
  maxAttempts: number;
  uniqueKey: string;
  lockedUntil: string | null;
  /** job_runs 中当前执行记录的全局单调序号；手动重试不会复用历史 attempt。 */
  activeRunAttempt: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobHandlerContext {
  jobId: string;
  attempt: number;
}

export type JobHandler = (payload: unknown, context: JobHandlerContext) => Promise<void> | void;

export function isRegisteredJobType(value: string): value is RegisteredJobType {
  return (registeredJobTypes as readonly string[]).includes(value);
}

/** 指数退避上限五分钟，attempt 从 1 开始；同一运行历史可据此重放调度时点。 */
export function retryDelayMs(attempt: number): number {
  return Math.min(300_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

export function errorSummary(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 1_000);
}
