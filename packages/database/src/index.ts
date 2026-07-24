import Database from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export * from "./schema.js";

const migrationsDirectory = new URL("../migrations/", import.meta.url);

export function utcNow(): string {
  return new Date().toISOString();
}

/** 仅接受整数最小货币单位，拒绝浮点结算值。 */
export function assertMinorUnits(amount: number): number {
  if (!Number.isSafeInteger(amount)) {
    throw new TypeError("金额必须是安全整数的最小货币单位");
  }
  return amount;
}

export function openSqliteDatabase(databasePath: string): Database.Database {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");
  migrateDatabase(database);
  assertDatabaseIntegrity(database);
  return database;
}

export function migrateDatabase(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    database.prepare("SELECT id FROM schema_migrations").all().map((row) => (row as { id: string }).id)
  );
  const directory = migrationsDirectory.pathname;
  const migrationFiles = readdirSync(directory).filter((file) => file.endsWith(".sql")).sort();
  for (const filename of migrationFiles) {
    if (applied.has(filename)) continue;
    const sql = readFileSync(join(directory, filename), "utf8");
    applyMigration(database, filename, sql);
  }
}

/** 单份迁移和其完成标记必须在同一个 SQLite 事务中提交。 */
export function applyMigration(database: Database.Database, id: string, sql: string): void {
  database.transaction(() => {
    database.exec(sql);
    database.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(id, utcNow());
  })();
}

export function assertDatabaseIntegrity(database: Database.Database): void {
  const result = database.pragma("integrity_check", { simple: true });
  if (result !== "ok") {
    throw new Error(`SQLite 完整性检查失败：${String(result)}`);
  }
}

/** 经济写入必须经由该短事务封装，调用者负责在其中同时更新事实、流水和审计。 */
export function withinTransaction<T>(database: Database.Database, operation: () => T): T {
  return database.transaction(operation)();
}
