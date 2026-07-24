import type Database from "better-sqlite3";
import { TaskRegistry, TaskWorker } from "./modules/jobs/application/task-service.js";
import { SqliteJobRepository } from "./modules/jobs/infrastructure/sqlite-job-repository.js";

export interface TaskRunner {
  stop(): Promise<void>;
}

/** 单进程串行调度器；SQLite 租约也使意外双实例只能条件领取一次。 */
export function startTaskRunner(database: Database.Database, intervalMs = 1_000, registry = new TaskRegistry()): TaskRunner {
  const worker = new TaskWorker(new SqliteJobRepository(database), registry);
  let stopping = false;
  let inFlight: Promise<void> | null = null;

  const tick = () => {
    if (stopping || inFlight) return;
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
