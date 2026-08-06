import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { ensureDailyPriceSyncScheduled, ensureDailyRolloverScheduled, ensureDailyBackupScheduled, ensureMarketQuoteRefreshScheduled, TaskRegistry, TaskWorker } from "./application/task-service.js";
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

describe("市场报价滚动刷新调度", () => {
  it("同一 10 分钟桶只投递一次，不同桶复用当日报价投影并持续推进执行时间", () => {
    const { database } = fixture();
    ensureMarketQuoteRefreshScheduled(database, new Date("2026-08-06T08:00:01.000Z"));
    ensureMarketQuoteRefreshScheduled(database, new Date("2026-08-06T08:09:59.000Z"));
    ensureMarketQuoteRefreshScheduled(database, new Date("2026-08-06T08:10:00.000Z"));
    const jobs = database.prepare(
      "SELECT unique_key, payload_json, run_after FROM jobs WHERE type = 'market.reprice' ORDER BY run_after ASC"
    ).all() as Array<{ unique_key: string; payload_json: string; run_after: string }>;
    expect(jobs).toEqual([
      { unique_key: "market-refresh:2026-08-06T08:00:00.000Z", payload_json: JSON.stringify({ triggerKey: "market-refresh:2026-08-06" }), run_after: "2026-08-06T08:00:01.000Z" },
      { unique_key: "market-refresh:2026-08-06T08:10:00.000Z", payload_json: JSON.stringify({ triggerKey: "market-refresh:2026-08-06" }), run_after: "2026-08-06T08:10:00.000Z" }
    ]);
    database.close();
  });

  it("UTC 跨日后切换报价投影键，避免覆盖上一自然日历史", () => {
    const { database } = fixture();
    ensureMarketQuoteRefreshScheduled(database, new Date("2026-08-06T23:59:59.000Z"));
    ensureMarketQuoteRefreshScheduled(database, new Date("2026-08-07T00:00:00.000Z"));
    const payloads = database.prepare(
      "SELECT payload_json FROM jobs WHERE type = 'market.reprice' ORDER BY run_after ASC"
    ).all() as Array<{ payload_json: string }>;
    expect(payloads.map((row) => JSON.parse(row.payload_json))).toEqual([
      { triggerKey: "market-refresh:2026-08-06" },
      { triggerKey: "market-refresh:2026-08-07" }
    ]);
    database.close();
  });
});

describe("I23B 每日日切调度", () => {
  it("按服务器时区投递日期/规则快照；同日与停机补跑都不会重复投递", () => {
    const { database } = fixture();
    const config = { timezone: "America/Los_Angeles", ruleVersion: "daily-work-funds/v1" };
    ensureDailyRolloverScheduled(database, config, new Date("2026-01-01T00:30:00.000Z"));
    ensureDailyRolloverScheduled(database, config, new Date("2026-01-01T07:59:00.000Z"));
    ensureDailyRolloverScheduled(database, config, new Date("2026-01-04T12:00:00.000Z"));
    const rows = database.prepare("SELECT unique_key, payload_json FROM jobs WHERE type = 'daily.rollover' ORDER BY unique_key").all() as Array<{ unique_key: string; payload_json: string }>;
    expect(rows.map((row) => ({ uniqueKey: row.unique_key, payload: JSON.parse(row.payload_json) }))).toEqual([
      { uniqueKey: "daily.rollover:2025-12-31", payload: { naturalDate: "2025-12-31", timezone: "America/Los_Angeles", workFundingRuleVersion: "daily-work-funds/v1" } },
      { uniqueKey: "daily.rollover:2026-01-04", payload: { naturalDate: "2026-01-04", timezone: "America/Los_Angeles", workFundingRuleVersion: "daily-work-funds/v1" } }
    ]);
    database.close();
  });
});

describe("I31B 每日备份调度", () => {
  it("UTC 自然日切换时投递一次 backup.create，同日重放不重复投递", () => {
    const { database } = fixture();
    ensureDailyBackupScheduled(database, new Date("2026-07-31T23:59:00.000Z"));
    const jobs = database.prepare("SELECT unique_key, payload_json FROM jobs WHERE type = 'backup.create'").all() as Array<{ unique_key: string; payload_json: string }>;
    expect(jobs).toEqual([{ unique_key: "backup.create:daily:2026-07-31", payload_json: JSON.stringify({ kind: "scheduled" }) }]);
    // 同日再次调用不应投递第二个任务。
    ensureDailyBackupScheduled(database, new Date("2026-07-31T23:59:59.000Z"));
    const sameDayJobs = database.prepare("SELECT unique_key FROM jobs WHERE type = 'backup.create'").all() as Array<{ unique_key: string }>;
    expect(sameDayJobs.length).toBe(1);
    const state = database.prepare("SELECT last_scheduled_date, last_attempted_run_after FROM backup_schedule_state WHERE singleton = 1").get() as { last_scheduled_date: string; last_attempted_run_after: string };
    expect(state.last_scheduled_date).toBe("2026-07-31");
    database.close();
  });

  it("跨日补跑以新自然日唯一键投递，停机多日只补一次而非逐日补投", () => {
    const { database } = fixture();
    ensureDailyBackupScheduled(database, new Date("2026-07-31T00:00:00.000Z"));
    ensureDailyBackupScheduled(database, new Date("2026-08-03T00:00:00.000Z")); // 停机 3 天后
    const jobs = database.prepare("SELECT unique_key FROM jobs WHERE type = 'backup.create' ORDER BY unique_key").all() as Array<{ unique_key: string }>;
    expect(jobs).toEqual([{ unique_key: "backup.create:daily:2026-07-31" }, { unique_key: "backup.create:daily:2026-08-03" }]);
    database.close();
  });
});
