import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { JobStatus } from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";
import { type PersistedJob, isRegisteredJobType } from "../domain/job.js";

type JobRow = {
  id: string; type: string; payload_json: string; status: string; run_after: string; attempts: number; max_attempts: number;
  unique_key: string; locked_until: string | null; last_error: string | null; created_at: string; updated_at: string;
};

function asJob(row: JobRow): PersistedJob {
  if (!isRegisteredJobType(row.type)) throw new Error(`数据库中存在未注册任务类型：${row.type}`);
  return {
    id: row.id, type: row.type, payloadJson: row.payload_json, status: row.status as JobStatus,
    runAfter: row.run_after, attempts: row.attempts, maxAttempts: row.max_attempts,
    uniqueKey: row.unique_key, lockedUntil: row.locked_until, lastError: row.last_error,
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export interface EnqueueJobInput {
  type: PersistedJob["type"];
  payload: unknown;
  uniqueKey: string;
  runAfter: string;
  maxAttempts?: number;
}

/** SQLite 条件更新确保同一任务在多个 API 进程间也只能被一个 worker 领取。 */
export class SqliteJobRepository {
  constructor(private readonly database: Database.Database) {}

  enqueue(input: EnqueueJobInput, now: string): PersistedJob {
    const id = randomUUID();
    const maxAttempts = input.maxAttempts ?? 3;
    this.database.prepare(
      `INSERT INTO jobs (id, type, payload_json, status, run_after, attempts, max_attempts, unique_key, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, ?, ?)
       ON CONFLICT(type, unique_key) DO NOTHING`
    ).run(id, input.type, JSON.stringify(input.payload), input.runAfter, maxAttempts, input.uniqueKey, now, now);
    return this.getByTypeAndUniqueKey(input.type, input.uniqueKey)!;
  }

  recoverExpired(now: string): number {
    return withinTransaction(this.database, () => {
      const dead = this.database.prepare(
        `UPDATE jobs SET status = 'dead', locked_until = NULL, last_error = COALESCE(last_error, '任务租约在进程中断后过期'), updated_at = ?
         WHERE ((status = 'running' AND locked_until <= ?) OR status = 'failed') AND attempts >= max_attempts`
      ).run(now, now).changes;
      this.database.prepare(
        `UPDATE jobs SET status = 'pending', locked_until = NULL, run_after = ?, last_error = COALESCE(last_error, '任务租约在进程中断后过期'), updated_at = ?
         WHERE status = 'running' AND locked_until <= ? AND attempts < max_attempts`
      ).run(now, now, now);
      return dead;
    });
  }

  claim(now: string, lockedUntil: string): PersistedJob | null {
    return withinTransaction(this.database, () => {
      this.recoverExpired(now);
      const candidate = this.database.prepare(
        `SELECT * FROM jobs WHERE status IN ('pending', 'failed') AND run_after <= ? AND attempts < max_attempts
         ORDER BY run_after ASC, created_at ASC LIMIT 1`
      ).get(now) as JobRow | undefined;
      if (!candidate) return null;
      const changed = this.database.prepare(
        `UPDATE jobs SET status = 'running', attempts = attempts + 1, locked_until = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'failed') AND run_after <= ? AND attempts < max_attempts`
      ).run(lockedUntil, now, candidate.id, now);
      if (changed.changes !== 1) return null;
      const job = this.get(candidate.id)!;
      this.database.prepare(
        "INSERT INTO job_runs (id, job_id, attempt, status, started_at) VALUES (?, ?, ?, 'running', ?)"
      ).run(randomUUID(), job.id, job.attempts, now);
      return job;
    });
  }

  succeed(job: PersistedJob, now: string): void {
    withinTransaction(this.database, () => {
      this.database.prepare("UPDATE jobs SET status = 'succeeded', locked_until = NULL, updated_at = ? WHERE id = ? AND status = 'running'").run(now, job.id);
      this.database.prepare("UPDATE job_runs SET status = 'succeeded', finished_at = ? WHERE job_id = ? AND attempt = ? AND status = 'running'").run(now, job.id, job.attempts);
    });
  }

  fail(job: PersistedJob, summary: string, runAfter: string, now: string): JobStatus {
    const status: JobStatus = job.attempts >= job.maxAttempts ? "dead" : "failed";
    withinTransaction(this.database, () => {
      this.database.prepare("UPDATE jobs SET status = ?, locked_until = NULL, run_after = ?, last_error = ?, updated_at = ? WHERE id = ? AND status = 'running'").run(status, runAfter, summary, now, job.id);
      this.database.prepare("UPDATE job_runs SET status = ?, finished_at = ?, error_summary = ? WHERE job_id = ? AND attempt = ? AND status = 'running'").run(status, now, summary, job.id, job.attempts);
    });
    return status;
  }

  manualRetry(id: string, now: string): PersistedJob | null {
    const changed = this.database.prepare(
      "UPDATE jobs SET status = 'pending', attempts = 0, run_after = ?, locked_until = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'dead')"
    ).run(now, now, id);
    return changed.changes === 1 ? this.get(id) : null;
  }

  get(id: string): PersistedJob | null {
    const row = this.database.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? asJob(row) : null;
  }

  getByTypeAndUniqueKey(type: string, uniqueKey: string): PersistedJob | null {
    const row = this.database.prepare("SELECT * FROM jobs WHERE type = ? AND unique_key = ?").get(type, uniqueKey) as JobRow | undefined;
    return row ? asJob(row) : null;
  }

  list(status: JobStatus | undefined, limit: number): PersistedJob[] {
    const sql = status ? "SELECT * FROM jobs WHERE status = ? ORDER BY updated_at DESC LIMIT ?" : "SELECT * FROM jobs ORDER BY updated_at DESC LIMIT ?";
    const rows = (status ? this.database.prepare(sql).all(status, limit) : this.database.prepare(sql).all(limit)) as JobRow[];
    return rows.map(asJob);
  }
}
