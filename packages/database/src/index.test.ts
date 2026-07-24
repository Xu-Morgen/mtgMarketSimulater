import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigration, assertMinorUnits, openSqliteDatabase, withinTransaction } from "./index.js";

const paths: string[] = [];
afterEach(() => paths.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe("database foundation", () => {
  it("migrates an empty database and enables SQLite safety pragmas", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-db-"));
    paths.push(directory);
    const database = openSqliteDatabase(join(directory, "test.db"));
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 6 });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get()).toEqual({ name: "accounts" });
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'game_archives'").get()).toEqual({ name: "game_archives" });
    expect(database.prepare("SELECT version FROM rule_versions WHERE rule_set = 'initial-funds'").get()).toEqual({ version: "v1" });
    expect(database.prepare("SELECT email, display_name, role, password_hash FROM users WHERE email = 'admin@local.test'").get()).toMatchObject({ email: "admin@local.test", display_name: "admin", role: "admin", password_hash: expect.stringMatching(/^\$argon2id\$/) });
    database.close();
  });

  it("upgrades the previous jobs-only prototype database", () => {
    const directory = mkdtempSync(join(tmpdir(), "mtg-db-"));
    paths.push(directory);
    const path = join(directory, "legacy.db");
    const legacy = new Database(path);
    legacy.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', run_after TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)");
    legacy.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("job-1", "prices.sync", "{}", "pending", "2026-07-24T00:00:00.000Z", 0, "2026-07-24T00:00:00.000Z", "2026-07-24T00:00:00.000Z");
    legacy.prepare("INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("job-2", "prices.sync", "{}", "pending", "2026-07-24T00:00:00.000Z", 0, "2026-07-24T00:00:00.000Z", "2026-07-24T00:00:00.000Z");
    legacy.close();
    const database = openSqliteDatabase(path);
    const columns = database.prepare("PRAGMA table_info(jobs)").all().map((row) => (row as { name: string }).name);
    expect(columns).toEqual(expect.arrayContaining(["max_attempts", "unique_key", "locked_until", "last_error"]));
    expect(database.prepare("SELECT unique_key FROM jobs ORDER BY id").all()).toEqual([{ unique_key: "job-1" }, { unique_key: "job-2" }]);
    database.close();
  });

  it("rolls back an unsuccessful short transaction and rejects fractional money", () => {
    const database = new Database(":memory:");
    database.exec("CREATE TABLE sample (value INTEGER NOT NULL)");
    expect(() => withinTransaction(database, () => { database.prepare("INSERT INTO sample VALUES (1)").run(); throw new Error("fail"); })).toThrow("fail");
    expect(database.prepare("SELECT COUNT(*) AS count FROM sample").get()).toEqual({ count: 0 });
    expect(() => assertMinorUnits(1.5)).toThrow("最小货币单位");
    expect(assertMinorUnits(100)).toBe(100);
    database.close();
  });

  it("does not leave a partial schema or migration record when a migration fails", () => {
    const database = new Database(":memory:");
    database.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
    expect(() => applyMigration(database, "broken.sql", "CREATE TABLE partial_table (id TEXT); INVALID SQL;")).toThrow();
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'partial_table'").get()).toBeUndefined();
    expect(database.prepare("SELECT id FROM schema_migrations WHERE id = 'broken.sql'").get()).toBeUndefined();
    database.close();
  });
});
