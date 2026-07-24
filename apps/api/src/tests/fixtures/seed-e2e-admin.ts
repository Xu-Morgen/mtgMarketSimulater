import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { openSqliteDatabase } from "@mtg-market/database";

const databasePath = process.env.E2E_DATABASE_PATH;
const email = process.env.E2E_ADMIN_EMAIL;
const password = process.env.E2E_ADMIN_PASSWORD;
const displayName = process.env.E2E_ADMIN_DISPLAY_NAME ?? "E2E 管理员";

if (!databasePath || !email || !password) {
  throw new Error("E2E_DATABASE_PATH、E2E_ADMIN_EMAIL 和 E2E_ADMIN_PASSWORD 均为必填项");
}

/** 仅用于隔离 SQLite 测试库；绝不针对开发或生产数据执行。 */
const database = openSqliteDatabase(databasePath);
const now = new Date().toISOString();
const passwordHash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
database.prepare(`
  INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at)
  VALUES (?, ?, ?, ?, 'admin', ?, ?)
  ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name, password_hash = excluded.password_hash, role = 'admin', updated_at = excluded.updated_at
`).run(randomUUID(), email.toLowerCase(), displayName, passwordHash, now, now);
database.close();
