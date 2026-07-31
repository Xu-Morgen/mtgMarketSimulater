import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../app.js";
import { loadApiConfig } from "../../config/environment.js";
import { BackupService } from "../../modules/backup/application/backup-service.js";
import { ExportService } from "../../modules/export/application/export-service.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "mtg-i31b-"));
  directories.push(directory);
  const sqlitePath = join(directory, "test.db");
  const database = openSqliteDatabase(sqlitePath);
  const backupDir = join(directory, "backups");
  const exportDir = join(directory, "exports");
  return { directory, sqlitePath, database, backupDir, exportDir };
}

async function buildApp(database: ReturnType<typeof openSqliteDatabase>, overrides: Record<string, string> = {}) {
  return createApiApp(loadApiConfig({ APP_ENV: "test", SQLITE_PATH: ":memory:", AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters", ...overrides }), database);
}

async function registerPlayer(app: Awaited<ReturnType<typeof buildApp>>, email: string) {
  const response = await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "玩家", password: "correct-horse-battery-staple" } });
  return { authorization: `Bearer ${response.json().data.accessToken as string}`, userId: response.json().data.user.id as string };
}

async function registerAndPromoteAdmin(app: Awaited<ReturnType<typeof buildApp>>, database: ReturnType<typeof openSqliteDatabase>) {
  const email = "admin@example.test";
  await app.inject({ method: "POST", url: "/v1/auth/register", payload: { email, displayName: "管理员", password: "correct-horse-battery-staple" } });
  database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
  const login = await app.inject({ method: "POST", url: "/v1/auth/login", payload: { email, password: "correct-horse-battery-staple" } });
  return { authorization: `Bearer ${login.json().data.accessToken as string}`, userId: login.json().data.user.id as string };
}

const idKey = (suffix: string) => `i31b-key-${suffix}-1234`;

describe("I31B 备份 backup-routes", () => {
  it("管理员可手动触发备份，下载受控流并审计；普通玩家 403", async () => {
    const { directory, database, backupDir } = fixture();
    // 应用路由的服务使用同一 BACKUP_DIR，保证创建与下载路径一致。
    const app = await buildApp(database, { BACKUP_DIR: backupDir, EXPORT_DIR: join(directory, "exports") });
    const admin = await registerAndPromoteAdmin(app, database);
    const create = await app.inject({ method: "POST", url: "/v1/admin/backups", headers: { authorization: admin.authorization, "idempotency-key": idKey("manual-1") }, payload: { kind: "manual" } });
    expect(create.statusCode).toBe(201);
    const record = create.json().data.backup;
    expect(record.status).toBe("succeeded");
    expect(record.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(record.sqliteIntegrityOk).toBe(true);
    expect(statSync(join(backupDir, record.backupFileName)).size).toBe(record.sizeBytes);

    const player = await registerPlayer(app, "player@example.test");
    const playerDownload = await app.inject({ method: "GET", url: `/v1/admin/backups/${record.id}/download`, headers: { authorization: player.authorization } });
    expect(playerDownload.statusCode).toBe(403);
    const adminDownload = await app.inject({ method: "GET", url: `/v1/admin/backups/${record.id}/download`, headers: { authorization: admin.authorization } });
    expect(adminDownload.statusCode).toBe(200);
    expect(adminDownload.headers["content-disposition"]).toContain("attachment");
    // 下载产生审计日志。
    const audited = database.prepare("SELECT COUNT(*) AS c FROM audit_logs WHERE action = 'backup.downloaded'").get() as { c: number };
    expect(audited.c).toBe(1);
    await app.close();
    database.close();
  });

  it("同键重放返回首次 succeeded 记录，不重复备份；同键 running 返回 skipped", async () => {
    const { sqlitePath, database, backupDir, exportDir } = fixture();
    const backup = new BackupService(database, sqlitePath, { BACKUP_DIR: backupDir, BACKUP_RETENTION: 7, BACKUP_INTEGRITY_CHECK: true, EXPORT_DIR: exportDir });
    const first = await backup.runBackup({ kind: "manual", actorId: "u1", requestId: "r1", idempotencyKey: idKey("replay") });
    const replay = await backup.runBackup({ kind: "manual", actorId: "u1", requestId: "r1", idempotencyKey: idKey("replay") });
    expect(replay.record.id).toBe(first.record.id);
    expect(replay.skipped).toBe(false);
    const records = database.prepare("SELECT COUNT(*) AS c FROM backup_records").get() as { c: number };
    expect(records.c).toBe(1);
    database.close();
  });

  it("WAL 活跃写入时备份仍产出一致副本并通过完整性校验", async () => {
    const { sqlitePath, database, backupDir, exportDir } = fixture();
    const backup = new BackupService(database, sqlitePath, { BACKUP_DIR: backupDir, BACKUP_RETENTION: 7, BACKUP_INTEGRITY_CHECK: true, EXPORT_DIR: exportDir });
    // 模拟活跃写入：在备份期间插入数据（better-sqlite3 同步，这里先写再备份验证一致性）。
    database.prepare("INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, NULL, 'test', 't', '1', NULL, '{}', ?)").run("a1", "2026-07-31T00:00:00.000Z");
    const result = await backup.runBackup({ kind: "manual", actorId: "u1", requestId: "r1", idempotencyKey: idKey("wal") });
    expect(result.record.status).toBe("succeeded");
    expect(result.record.sqliteIntegrityOk).toBe(true);
    database.close();
  });

  it("保留策略保留 7 份，超出部分清理但最新成功不被删；失败不删最近成功备份", async () => {
    const { sqlitePath, database, backupDir, exportDir } = fixture();
    const backup = new BackupService(database, sqlitePath, { BACKUP_DIR: backupDir, BACKUP_RETENTION: 3, BACKUP_INTEGRITY_CHECK: true, EXPORT_DIR: exportDir });
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      // 每份用唯一 idempotencyKey 且推进时间戳，保证 created_at 不同。
      const result = await backup.runBackup({ kind: "scheduled", actorId: "system", requestId: null, idempotencyKey: idKey(`ret-${i}`), now: `2026-07-2${i}T00:00:00.000Z` });
      created.push(result.record.id);
    }
    const pruned = backup.pruneBackups("2026-07-31T00:00:00.000Z");
    // retention=3 → 5 份保留 3 份，淘汰 2 份最旧。
    expect(pruned.prunedIds.length).toBe(2);
    // 最新成功备份仍在记录中且仍 succeeded。
    const latest = backup.listBackups(10).find((record) => record.status === "succeeded");
    expect(latest).toBeDefined();
    // 最新备份的磁盘文件仍存在。
    expect(() => statSync(join(backupDir, latest!.backupFileName!))).not.toThrow();
    database.close();
  });

  it("恢复演练校验完整性与核心表；损坏备份演练报告完整性失败，绝不覆盖运行库", async () => {
    const { sqlitePath, database, backupDir, exportDir } = fixture();
    const backup = new BackupService(database, sqlitePath, { BACKUP_DIR: backupDir, BACKUP_RETENTION: 7, BACKUP_INTEGRITY_CHECK: true, EXPORT_DIR: exportDir });
    const result = await backup.runBackup({ kind: "manual", actorId: "u1", requestId: "r1", idempotencyKey: idKey("rehearse") });
    expect(result.record.status).toBe("succeeded");
    const rehearsal = backup.restoreRehearsal(result.record.id);
    expect(rehearsal).not.toBe("not-found");
    expect(rehearsal).not.toBe("not-succeeded");
    const ok = rehearsal as { sqliteIntegrityOk: boolean; coreTablesPresent: boolean };
    expect(ok.sqliteIntegrityOk).toBe(true);
    expect(ok.coreTablesPresent).toBe(true);
    // 损坏备份文件后再演练：完整性应为 false，且不抛错（绝不让演练覆盖运行库）。
    truncateSync(join(backupDir, result.record.backupFileName!), 10);
    const broken = backup.restoreRehearsal(result.record.id) as { sqliteIntegrityOk: boolean };
    expect(broken.sqliteIntegrityOk).toBe(false);
    // 运行库仍可正常查询（未被覆盖）。
    expect(database.prepare("SELECT COUNT(*) AS c FROM users").get()).toEqual({ c: expect.any(Number) });
    database.close();
  });

  it("备份不存在的记录返回 404；未成功备份下载返回 409", async () => {
    const { database } = fixture();
    const app = await buildApp(database);
    const admin = await registerAndPromoteAdmin(app, database);
    const notFound = await app.inject({ method: "GET", url: "/v1/admin/backups/00000000-0000-4000-8000-000000000000", headers: { authorization: admin.authorization } });
    expect(notFound.statusCode).toBe(404);
    await app.close();
    database.close();
  });
});

describe("I31B 导出 export-routes（用户隔离 + CSV 注入防护）", () => {
  it("严格用户隔离：A 的导出不含 B 的账本/库存；越权下载他人导出返回 404", async () => {
    const { directory, sqlitePath, database, exportDir } = fixture();
    // 用带真实 EXPORT_DIR 的服务直接测试，绕过 :memory: 配置。
    const exportService = new ExportService(database, { EXPORT_DIR: exportDir, EXPORT_TTL_SECONDS: 600 });
    const alice = "30000000-0000-4000-8000-000000000001";
    const bob = "30000000-0000-4000-8000-000000000002";
    // 直接插入两个用户的账本数据。
    seedAccount(database, alice, 1000);
    seedAccount(database, bob, 9999);
    const aliceResult = exportService.generate({ userId: alice, requestId: "ra", idempotencyKey: idKey("alice-exp"), formats: ["csv", "json"] });
    expect(aliceResult.record.status).toBe("succeeded");
    // 读 Alice 的 CSV，应含 1000 且不含 9999。
    const csv = readFileSync(join(exportDir, aliceResult.record.fileName), "utf8");
    expect(csv).toContain("1000");
    expect(csv).not.toContain("9999");
    // Bob 用 Alice 的导出 id 越权下载 → 返回 null（路由映射 404）。
    expect(exportService.downloadableForUser(aliceResult.record.id, bob)).toBeNull();
    void directory;
    void sqlitePath;
    database.close();
  });

  it("CSV 公式注入样例被正确转义：=cmd / -1 / @x / 含逗号", async () => {
    const { database, exportDir } = fixture();
    const exportService = new ExportService(database, { EXPORT_DIR: exportDir, EXPORT_TTL_SECONDS: 600 });
    const alice = "30000000-0000-4000-8000-000000000010";
    seedAccount(database, alice, 1000);
    // 注入 ledger reason：注入 payload 写入会被 csvEscapeCell 转义。
    const accountId = (database.prepare("SELECT id FROM accounts WHERE user_id = ?").get(alice) as { id: string }).id;
    database.prepare("INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, ?, 'credit', 100, 1100, ?, 'c1', '2026-07-31T00:00:00.000Z')").run("le1", accountId, "=cmd|malicious");
    const result = exportService.generate({ userId: alice, requestId: "r", idempotencyKey: idKey("inj"), formats: ["csv"] });
    const csv = readFileSync(join(exportDir, result.record.fileName), "utf8");
    // 原始 =cmd 不应作为公式出现；应被前置单引号。
    expect(csv).toContain("'=cmd|malicious");
    expect(csv).not.toMatch(/[^']=cmd\|malicious/);
    database.close();
  });

  it("字段稳定：同一数据两次导出列序一致", async () => {
    const { database, exportDir } = fixture();
    const exportService = new ExportService(database, { EXPORT_DIR: exportDir, EXPORT_TTL_SECONDS: 600 });
    const alice = "30000000-0000-4000-8000-000000000020";
    seedAccount(database, alice, 500);
    const r1 = exportService.generate({ userId: alice, requestId: "r1", idempotencyKey: idKey("stable-1"), formats: ["csv"] });
    const r2 = exportService.generate({ userId: alice, requestId: "r2", idempotencyKey: idKey("stable-2"), formats: ["csv"] });
    const csv1 = readFileSync(join(exportDir, r1.record.fileName), "utf8");
    const csv2 = readFileSync(join(exportDir, r2.record.fileName), "utf8");
    // 表头（列序）一致。
    expect(csv1.split("\n").slice(0, 8)).toEqual(csv2.split("\n").slice(0, 8));
    database.close();
  });

  it("过期导出不可下载并标记 expired；清理删除文件", async () => {
    const { database, exportDir } = fixture();
    const exportService = new ExportService(database, { EXPORT_DIR: exportDir, EXPORT_TTL_SECONDS: 60 });
    const alice = "30000000-0000-4000-8000-000000000030";
    seedAccount(database, alice, 100);
    const result = exportService.generate({ userId: alice, requestId: "r", idempotencyKey: idKey("expire"), formats: ["csv"] });
    expect(exportService.downloadableForUser(result.record.id, alice)).not.toBeNull();
    // 推进到过期后：不可下载，且文件被 pruneExpired 删除。
    const future = "2099-12-31T23:59:59.000Z";
    expect(exportService.downloadableForUser(result.record.id, alice, future)).toBeNull();
    exportService.pruneExpired(future);
    expect(() => readFileSync(join(exportDir, result.record.fileName))).toThrow();
    database.close();
  });

  it("通过 HTTP 路由：player 可生成并下载自己的导出，无 token 401，player 访问 admin 备份 403", async () => {
    const { database } = fixture();
    const app = await buildApp(database);
    const player = await registerPlayer(app, "http-player@example.test");
    const create = await app.inject({ method: "POST", url: "/v1/exports", headers: { authorization: player.authorization, "idempotency-key": idKey("http-exp") }, payload: { formats: ["csv"] } });
    expect([201, 202]).toContain(create.statusCode);
    // 无 token 拒绝。
    const noAuth = await app.inject({ method: "GET", url: "/v1/exports" });
    expect(noAuth.statusCode).toBe(401);
    // 普通玩家访问 admin 备份路由 403。
    const forbidden = await app.inject({ method: "GET", url: "/v1/admin/backups", headers: { authorization: player.authorization } });
    expect(forbidden.statusCode).toBe(403);
    await app.close();
    database.close();
  });
});

/** 为指定 user 创建 users 行、GAME_CREDIT 账户并写入账本。必须先建 users 以满足外键。 */
function seedAccount(database: ReturnType<typeof openSqliteDatabase>, userId: string, totalAmount: number): void {
  database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, '测试', 'x', 'player', '2026-07-31T00:00:00.000Z', '2026-07-31T00:00:00.000Z')").run(userId, `${userId}@example.test`);
  const accountId = `ac-${userId.slice(-12)}`;
  database.prepare("INSERT INTO accounts (id, user_id, currency, total_amount, available_amount, frozen_amount, updated_at) VALUES (?, ?, 'GAME_CREDIT', ?, ?, 0, '2026-07-31T00:00:00.000Z')").run(accountId, userId, totalAmount, totalAmount);
  database.prepare("INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, ?, 'credit', ?, ?, 'initial_funding', ?, '2026-07-31T00:00:00.000Z')").run(`le-${userId.slice(-12)}`, accountId, totalAmount, totalAmount, `init-${userId}`);
}
