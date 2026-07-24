import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { TaskRegistry, TaskWorker } from "./application/task-service.js";
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
