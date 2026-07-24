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

/** I08F 浏览器夹具：三个独立 SKU，覆盖同名不同印刷、工艺与无图片降级。 */
database.prepare("INSERT OR IGNORE INTO card_sets (id, code, name, released_at, source, source_reference, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("10000000-0000-4000-8000-000000000081", "ONE", "Phyrexia: All Will Be One", "2023-02-10", "scryfall", "one", now);
const printing = database.prepare("INSERT OR IGNORE INTO card_printings (id, set_id, name, collector_number, scryfall_id, oracle_text, rarity, legalities_json, artist, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
printing.run("20000000-0000-4000-8000-000000000081", "10000000-0000-4000-8000-000000000081", "Elesh Norn, Mother of Machines", "10", "e2e-one-10", "Vigilance", "mythic", '{"standard":"not_legal"}', "A. Artist", "scryfall", "e2e-one-10", 0, now, now);
printing.run("20000000-0000-4000-8000-000000000082", "10000000-0000-4000-8000-000000000081", "Elesh Norn, Mother of Machines", "11", "e2e-one-11", null, "rare", '{"standard":"legal"}', null, "scryfall", "e2e-one-11", 0, now, now);
const sku = database.prepare("INSERT OR IGNORE INTO card_skus (id, printing_id, finish, tradable, source, source_reference, is_manual_exception, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
sku.run("30000000-0000-4000-8000-000000000081", "20000000-0000-4000-8000-000000000081", "nonfoil", 1, "scryfall", "e2e-one-10", 0, now, now);
sku.run("30000000-0000-4000-8000-000000000082", "20000000-0000-4000-8000-000000000081", "foil", 1, "scryfall", "e2e-one-10", 0, now, now);
sku.run("30000000-0000-4000-8000-000000000083", "20000000-0000-4000-8000-000000000082", "etched", 1, "scryfall", "e2e-one-11", 0, now, now);
database.prepare("INSERT OR IGNORE INTO card_image_cache (id, printing_id, source_url, cache_path, status, checksum, cached_at, failure_reason, updated_at) VALUES (?, ?, ?, ?, 'cached', ?, ?, NULL, ?)").run("40000000-0000-4000-8000-000000000081", "20000000-0000-4000-8000-000000000081", "https://fixture.invalid/one-10.jpg", "catalog/e2e-one-10.jpg", "e2e", now, now);
database.close();
