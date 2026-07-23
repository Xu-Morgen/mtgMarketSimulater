import type Database from "better-sqlite3";

/**
 * 单实例任务循环：任务持久化在 SQLite，因此停机后能在下次启动继续领取。
 * 经济结算任务必须在业务模块中使用幂等键；此处只负责按序调度。
 */
export function startTaskRunner(database: Database.Database) {
  const timer = setInterval(() => {
    const now = new Date().toISOString();
    database
      .prepare(
        "UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = (SELECT id FROM jobs WHERE status = 'pending' AND run_after <= ? ORDER BY run_after LIMIT 1)"
      )
      .run(now, now);
  }, 1_000);

  timer.unref();
  return () => clearInterval(timer);
}
