import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { ensureDailyPriceSyncScheduled, TaskRegistry, TaskWorker } from "./application/task-service.js";
import { SqliteJobRepository } from "./infrastructure/sqlite-job-repository.js";
import { startTaskRunner } from "../../task-runner.js";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-jobs-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "jobs.db"));
  return { database, repository: new SqliteJobRepository(database) };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("持久化任务 worker", () => {
  it("条件领取使重复 worker 只能执行一次", async () => {
    const { database, repository } = fixture();
    const now = new Date("2026-07-24T00:00:00.000Z");
    repository.enqueue({ type: "prices.sync", payload: {}, uniqueKey: "2026-07-24", runAfter: now.toISOString() }, now.toISOString());
    let calls = 0;
    const registry = new TaskRegistry(); registry.register("prices.sync", () => { calls += 1; });
    const clock = () => new Date(now);
    await Promise.all([new TaskWorker(repository, registry, clock).runOne(), new TaskWorker(repository, registry, clock).runOne()]);
    expect(calls).toBe(1);
    expect(repository.list(undefined, 10)[0]?.status).toBe("succeeded");
    database.close();
  });

  it("租约过期后可在启动恢复，失败按退避并最终进入 dead，且可手动重试", async () => {
    const { database, repository } = fixture();
    let clockNow = new Date("2026-07-24T00:00:00.000Z");
    const clock = () => new Date(clockNow);
    const job = repository.enqueue({ type: "catalog.sync", payload: {}, uniqueKey: "bulk", runAfter: clockNow.toISOString(), maxAttempts: 3 }, clockNow.toISOString());
    expect(repository.claim(clockNow.toISOString(), "2026-07-24T00:00:01.000Z")?.status).toBe("running");
    clockNow = new Date("2026-07-24T00:00:02.000Z");
    const registry = new TaskRegistry(); registry.register("catalog.sync", () => { throw new Error("上游临时失败"); });
    const worker = new TaskWorker(repository, registry, clock);
    worker.recover();
    await worker.runOne();
    const current = repository.get(job.id)!;
    expect(current.status).toBe("failed");
    expect(current.runAfter).toBe("2026-07-24T00:00:04.000Z");
    clockNow = new Date("2026-07-24T00:00:04.000Z");
    await worker.runOne();
    expect(repository.get(job.id)?.status).toBe("dead");
    expect(repository.manualRetry(job.id, clockNow.toISOString())?.status).toBe("pending");
    await worker.runOne();
    expect(repository.get(job.id)?.status).toBe("failed");
    expect(database.prepare("SELECT attempt FROM job_runs WHERE job_id = ? ORDER BY attempt").all(job.id)).toEqual([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }, { attempt: 4 }]);
    database.close();
  });

  it("优雅停机停止新领取并等待正在执行的处理器", async () => {
    const { database, repository } = fixture();
    repository.enqueue({ type: "backup.create", payload: {}, uniqueKey: "shutdown", runAfter: new Date().toISOString() }, new Date().toISOString());
    let release!: () => void;
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const registry = new TaskRegistry();
    registry.register("backup.create", () => new Promise<void>((resolve) => { release = resolve; signalStarted(); }));
    const runner = startTaskRunner(database, 1, registry);
    await started;
    let stopped = false;
    const stopping = runner.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(repository.list(undefined, 1)[0]?.status).toBe("succeeded");
    database.close();
  });
});

describe("I17B 每日价格同步调度", () => {
  it("UTC 自然日切换时投递一次 prices.sync，同日重放不重复投递", () => {
    const { database } = fixture();
    const day1 = new Date("2026-07-26T23:59:00.000Z");
    ensureDailyPriceSyncScheduled(database, day1);
    const jobs = database.prepare("SELECT unique_key, type FROM jobs WHERE type = 'prices.sync'").all() as Array<{ unique_key: string; type: string }>;
    expect(jobs).toEqual([{ unique_key: "prices.sync:daily:2026-07-26", type: "prices.sync" }]);
    // 同日再次调用不应投递第二个任务。
    ensureDailyPriceSyncScheduled(database, new Date("2026-07-26T23:59:59.000Z"));
    const sameDayJobs = database.prepare("SELECT unique_key FROM jobs WHERE type = 'prices.sync'").all() as Array<{ unique_key: string }>;
    expect(sameDayJobs.length).toBe(1);
    const state = database.prepare("SELECT last_scheduled_date, last_attempted_run_after FROM price_sync_schedule_state WHERE singleton = 1").get() as { last_scheduled_date: string; last_attempted_run_after: string };
    expect(state.last_scheduled_date).toBe("2026-07-26");
    expect(state.last_attempted_run_after).toBe("2026-07-26T23:59:00.000Z");
    database.close();
  });

  it("跨日补跑以新自然日唯一键投递，停机多日只补一次而非逐日补投", () => {
    const { database } = fixture();
    ensureDailyPriceSyncScheduled(database, new Date("2026-07-26T00:00:00.000Z"));
    ensureDailyPriceSyncScheduled(database, new Date("2026-07-29T00:00:00.000Z")); // 停机 3 天后
    const jobs = database.prepare("SELECT unique_key FROM jobs WHERE type = 'prices.sync' ORDER BY unique_key").all() as Array<{ unique_key: string }>;
    expect(jobs).toEqual([{ unique_key: "prices.sync:daily:2026-07-26" }, { unique_key: "prices.sync:daily:2026-07-29" }]);
    database.close();
  });
});
