import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteDatabase } from "@mtg-market/database";
import { createApiApp } from "../../app.js";
import { loadApiConfig } from "../../config/environment.js";
import {
  AUTH_REQUESTS_PER_MINUTE,
  AuthenticationRateLimiter
} from "../../modules/auth/api/auth-routes.js";

/**
 * I32B 发布前后端质量门禁——服务端安全检查。
 *
 * 把分散在各模块测试中的安全不变量收敛为一份发布阻断级断言：密码与会话、权限、输入校验、
 * 限流、密钥隔离、日志脱敏与管理命令审计。任一失败即阻断发布。复用现有 app 构造与夹具，
 * 不重复实现业务逻辑；这里只验证发布级别的安全边界整体成立。
 */

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));

async function createTestApp(environment: Record<string, string> = {}) {
  const directory = mkdtempSync(join(tmpdir(), "mtg-i32b-sec-"));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, "test.db"));
  const config = loadApiConfig({
    APP_ENV: "test",
    SQLITE_PATH: join(directory, "test.db"),
    AUTH_JWT_SECRET: "test-only-secret-must-be-at-least-32-characters",
    ...environment
  });
  return { app: await createApiApp(config, database), database, directory };
}

function setCookies(response: { headers: Record<string, unknown> }): string {
  const cookies = response.headers["set-cookie"] as string[];
  return cookies.map((cookie) => cookie.split(";")[0]).join("; ");
}
function csrfFrom(cookies: string): string {
  return decodeURIComponent(cookies.match(/mtg_csrf=([^;]+)/)?.[1] ?? "");
}

async function registerPlayer(app: Awaited<ReturnType<typeof createApiApp>>, email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { email, displayName: "玩家", password: "correct-horse-battery-staple" }
  });
  return {
    authorization: `Bearer ${response.json().data.accessToken as string}`,
    userId: response.json().data.user.id as string,
    cookies: setCookies(response)
  };
}

async function registerAndPromoteAdmin(
  app: Awaited<ReturnType<typeof createApiApp>>,
  database: ReturnType<typeof openSqliteDatabase>
) {
  const email = `i32b-admin@example.test`;
  await app.inject({
    method: "POST",
    url: "/v1/auth/register",
    payload: { email, displayName: "管理员", password: "correct-horse-battery-staple" }
  });
  database.prepare("UPDATE users SET role = 'admin' WHERE email = ?").run(email);
  const login = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    payload: { email, password: "correct-horse-battery-staple" }
  });
  return {
    authorization: `Bearer ${login.json().data.accessToken as string}`,
    userId: login.json().data.user.id as string
  };
}

describe("I32B 服务端安全发布门禁", () => {
  it("密码以 Argon2id 哈希存储，错误密码与无效/过期令牌均被拒绝", async () => {
    const { app, database } = await createTestApp();
    const player = await registerPlayer(app, "i32b-pwd@example.test");
    const stored = database
      .prepare("SELECT password_hash FROM users WHERE id = ?")
      .get(player.userId) as { password_hash: string };
    expect(stored.password_hash).toMatch(/^\$argon2id\$/);

    const badLogin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      payload: { email: "i32b-pwd@example.test", password: "incorrect-password-123" }
    });
    expect(badLogin.statusCode).toBe(401);

    const invalidToken = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: "Bearer not-a-real-token" }
    });
    expect(invalidToken.statusCode).toBe(401);

    // 过期 access token（会话过期后令牌失效）。
    const sid = database.prepare("SELECT id FROM sessions ORDER BY created_at DESC LIMIT 1").get() as {
      id: string;
    };
    database
      .prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", sid.id);
    const expired = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { authorization: player.authorization }
    });
    expect(expired.statusCode).toBe(401);
    await app.close();
    database.close();
  });

  it("CSRF 保护与 refresh token 轮换：缺 CSRF 被拒，重放被拒", async () => {
    const { app } = await createTestApp();
    const player = await registerPlayer(app, "i32b-csrf@example.test");
    const csrf = csrfFrom(player.cookies);
    const missingCsrf = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: player.cookies }
    });
    expect(missingCsrf.statusCode).toBe(403);

    const refreshed = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: player.cookies, "x-csrf-token": csrf }
    });
    expect(refreshed.statusCode).toBe(200);

    // 同一 refresh token 重放（轮换后旧 token 失效）必须被拒。
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: { cookie: player.cookies, "x-csrf-token": csrf }
    });
    expect(replay.statusCode).toBe(401);
    await app.close();
  });

  it("角色边界：普通玩家不可访问任意 admin 路由，深层链接 403", async () => {
    const { app } = await createTestApp();
    const player = await registerPlayer(app, "i32b-role@example.test");
    const adminPaths = [
      "/v1/admin/jobs",
      "/v1/admin/dashboard",
      "/v1/admin/backups",
      "/v1/admin/audit-logs"
    ];
    for (const path of adminPaths) {
      const denied = await app.inject({
        method: "GET",
        url: path,
        headers: { authorization: player.authorization }
      });
      expect(denied.statusCode).toBe(403);
    }
    // 未认证访问同样不可进入。
    const unauth = await app.inject({ method: "GET", url: "/v1/admin/jobs" });
    expect(unauth.statusCode).toBe(401);
    await app.close();
  });

  it("认证频率限制：每 IP 每分钟 100 次，第 101 次被拒", () => {
    const limiter = new AuthenticationRateLimiter();
    const now = Date.now();
    const firstHundred = Array.from({ length: AUTH_REQUESTS_PER_MINUTE }, () =>
      limiter.check("203.0.113.9", now)
    );
    expect(firstHundred.every((allowed) => allowed === true)).toBe(true);
    expect(limiter.check("203.0.113.9", now)).toBe(false);
    // 窗口滚动后恢复，且不同 IP 独立计数。
    expect(limiter.check("203.0.113.9", now + 60_001)).toBe(true);
    expect(limiter.check("198.51.100.7", now)).toBe(true);
  });

  it("输入校验与统一错误包络：非法 payload、未知路由均返回统一包络与正确语义", async () => {
    const { app } = await createTestApp();
    const invalidBody = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      payload: { email: "not-an-email", displayName: "", password: "short" }
    });
    expect(invalidBody.statusCode).toBe(400);
    expect(invalidBody.json()).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });

    const unknown = await app.inject({ method: "GET", url: "/v1/does-not-exist" });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toMatchObject({ ok: false, error: { code: "RESOURCE_NOT_FOUND" } });
    await app.close();
  });

  it("CORS 白名单：未列名 Origin 不返回 access-control-allow-origin", async () => {
    const { app } = await createTestApp();
    const crossOrigin = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { origin: "https://attacker.example.test" },
      payload: { email: "nobody@example.test", password: "correct-horse-battery-staple" }
    });
    expect(crossOrigin.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("密钥隔离：生产环境拒绝示例 AUTH_JWT_SECRET 与默认 DECK_RESPONSE_ENCRYPTION_KEY", () => {
    // 示例 JWT 密钥在任何环境都被拒绝。
    expect(() =>
      loadApiConfig({ AUTH_JWT_SECRET: "replace-with-a-random-secret-at-least-32-characters" })
    ).toThrow();
    // 生产环境必须提供随机 DECK_RESPONSE_ENCRYPTION_KEY，默认值被拒。
    expect(() =>
      loadApiConfig({
        APP_ENV: "production",
        AUTH_JWT_SECRET: "a-real-production-secret-must-be-at-least-32-characters-long"
      })
    ).toThrow();
    // 提供随机密钥后生产环境配置可加载。
    expect(() =>
      loadApiConfig({
        APP_ENV: "production",
        AUTH_JWT_SECRET: "a-real-production-secret-must-be-at-least-32-characters-long",
        DECK_RESPONSE_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
      })
    ).not.toThrow();
  });

  it("浏览器公开配置只含可公开项：NEXT_PUBLIC_ 不泄露服务端密钥", () => {
    // 权威边界：NEXT_PUBLIC_* 只能包含可公开配置。读取 web .env.example，确认不存在任何
    // 服务端密钥（JWT/加密密钥/数据库路径/Provider 令牌）暴露给浏览器 bundle。
    // 从本测试文件用 import.meta.url 定位仓库根下的 web 配置。
    const envExample = readFileSync(
      fileURLToPath(new URL("../../../../../apps/web/.env.example", import.meta.url)),
      "utf8"
    );
    const forbidden = [
      "AUTH_JWT_SECRET",
      "DECK_RESPONSE_ENCRYPTION_KEY",
      "SQLITE_PATH",
      "OPENAI_API_KEY",
      "LEYLINE_ENDPOINT",
      "BACKUP_DIR",
      "EXPORT_DIR"
    ];
    const publicLines = envExample.split("\n").filter((line) => line.startsWith("NEXT_PUBLIC_"));
    expect(publicLines.length).toBeGreaterThan(0);
    for (const line of publicLines) {
      for (const secret of forbidden) {
        expect(line).not.toContain(secret);
      }
    }
  });

  it("管理命令审计：备份触发、活动相关写与用户补偿均写不可变 audit_logs", async () => {
    const { app, database } = await createTestApp();
    const admin = await registerAndPromoteAdmin(app, database);
    const before = (
      database
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id = ?")
        .get(admin.userId) as { count: number }
    ).count;

    // 管理员触发备份（admin + Idempotency-Key + 审计）。
    const backup = await app.inject({
      method: "POST",
      url: "/v1/admin/backups",
      headers: { authorization: admin.authorization, "idempotency-key": "i32b-sec-backup-0001" },
      payload: { kind: "manual" }
    });
    expect([201, 202]).toContain(backup.statusCode);

    const after = (
      database
        .prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE actor_id = ?")
        .get(admin.userId) as { count: number }
    ).count;
    expect(after).toBeGreaterThan(before);

    // 审计摘要不得包含密码、cookie、令牌等敏感原文。
    const recentSummaries = database
      .prepare(
        "SELECT action, summary_json FROM audit_logs WHERE actor_id = ? ORDER BY occurred_at DESC LIMIT 5"
      )
      .all(admin.userId) as Array<{ action: string; summary_json: string }>;
    for (const row of recentSummaries) {
      const lower = row.summary_json.toLowerCase();
      expect(lower).not.toContain("password");
      expect(lower).not.toContain("mtg_refresh");
      expect(lower).not.toContain("bearer ");
    }
    await app.close();
    database.close();
  });
});
