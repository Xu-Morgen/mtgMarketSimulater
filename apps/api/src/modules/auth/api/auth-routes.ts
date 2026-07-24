import type Database from "better-sqlite3";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ApiConfig } from "../../../config/environment.js";
import { failure, success } from "../../../shared/http/api-response.js";
import { AuthService, type AuthenticatedUser, type SessionCredentials } from "../application/auth-service.js";
import { verifyAccessToken } from "../domain/token.js";

const credentialsSchema = z.object({ email: z.string().trim().email().max(320), password: z.string().min(12).max(128) }).strict();
const registrationSchema = credentialsSchema.extend({ displayName: z.string().trim().min(2).max(40) }).strict();
const refreshCookie = "mtg_refresh"; const csrfCookie = "mtg_csrf";

declare module "fastify" { interface FastifyRequest { actor: AuthenticatedUser | null; } }

function parseCookies(header: string | undefined): Record<string, string> { return Object.fromEntries((header ?? "").split(";").map((part) => part.trim().split(/=(.*)/s)).filter(([key, value]) => Boolean(key && value)).map(([key, value]) => [key!, decodeURIComponent(value!)])); }
function serializeCookie(name: string, value: string, config: ApiConfig, httpOnly: boolean): string {
  return [`${name}=${encodeURIComponent(value)}`, "Path=/v1/auth", `Max-Age=${config.REFRESH_TOKEN_TTL_SECONDS}`, "SameSite=Strict", ...(httpOnly ? ["HttpOnly"] : []), ...(config.APP_ENV === "production" ? ["Secure"] : [])].join("; ");
}
function expiredCookie(name: string): string { return `${name}=; Path=/v1/auth; Max-Age=0; SameSite=Strict`; }
function sendSession(reply: FastifyReply, request: FastifyRequest, config: ApiConfig, credentials: SessionCredentials, code = 200) {
  reply.header("Set-Cookie", [serializeCookie(refreshCookie, credentials.refreshToken, config, true), serializeCookie(csrfCookie, credentials.csrfToken, config, false)]);
  return reply.code(code).send(success(request.requestId, { accessToken: credentials.accessToken, user: credentials.user }));
}
function unauthorized(request: FastifyRequest, reply: FastifyReply) { return reply.code(401).send(failure(request.requestId, "AUTHENTICATION_INVALID", "认证凭据无效或已过期")); }

/** 小型单机部署的本地滑动窗口限制；不作为跨进程风控替代。 */
class AuthenticationRateLimiter {
  private readonly attempts = new Map<string, number[]>();
  check(ip: string, now = Date.now()): boolean { const values = (this.attempts.get(ip) ?? []).filter((at) => at > now - 60_000); values.push(now); this.attempts.set(ip, values); return values.length <= 10; }
}

export async function registerAuthRoutes(app: FastifyInstance, config: ApiConfig, database: Database.Database): Promise<void> {
  const auth = new AuthService(database, config); const limiter = new AuthenticationRateLimiter();
  app.addHook("preHandler", async (request) => {
    const authorization = request.headers.authorization;
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const claims = token ? verifyAccessToken(token, config.AUTH_JWT_SECRET, new Date()) : null;
    request.actor = claims ? auth.current(claims) : null;
  });
  app.post("/v1/auth/register", async (request, reply) => {
    if (!limiter.check(request.ip)) return reply.code(429).send(failure(request.requestId, "RATE_LIMITED", "认证请求过于频繁，请稍后再试"));
    const body = registrationSchema.parse(request.body); const result = await auth.register(body);
    if (result === "email-conflict") return reply.code(409).send(failure(request.requestId, "RESOURCE_CONFLICT", "邮箱已被注册"));
    return sendSession(reply, request, config, result, 201);
  });
  app.post("/v1/auth/login", async (request, reply) => {
    if (!limiter.check(request.ip)) return reply.code(429).send(failure(request.requestId, "RATE_LIMITED", "认证请求过于频繁，请稍后再试"));
    const body = credentialsSchema.parse(request.body); const result = await auth.login(body.email, body.password);
    return result ? sendSession(reply, request, config, result) : unauthorized(request, reply);
  });
  app.post("/v1/auth/refresh", async (request, reply) => {
    if (!limiter.check(request.ip)) return reply.code(429).send(failure(request.requestId, "RATE_LIMITED", "认证请求过于频繁，请稍后再试"));
    const cookies = parseCookies(request.headers.cookie); const csrf = request.headers["x-csrf-token"];
    const result = await auth.rotate(cookies[refreshCookie] ?? "", typeof csrf === "string" ? csrf : "");
    if (result === "csrf") return reply.code(403).send(failure(request.requestId, "AUTHORIZATION_DENIED", "CSRF 校验失败"));
    if (result === "invalid" || result === "replayed") { reply.header("Set-Cookie", [expiredCookie(refreshCookie), expiredCookie(csrfCookie)]); return unauthorized(request, reply); }
    return sendSession(reply, request, config, result);
  });
  app.post("/v1/auth/logout", async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie); const csrf = request.headers["x-csrf-token"];
    const result = auth.logout(cookies[refreshCookie], typeof csrf === "string" ? csrf : undefined);
    if (result === "csrf") return reply.code(403).send(failure(request.requestId, "AUTHORIZATION_DENIED", "CSRF 校验失败"));
    reply.header("Set-Cookie", [expiredCookie(refreshCookie), expiredCookie(csrfCookie)]);
    return success(request.requestId, { loggedOut: true });
  });
  app.get("/v1/auth/session", async (request, reply) => request.actor ? success(request.requestId, { user: request.actor }) : unauthorized(request, reply));
}

export function requireRole(role: "player" | "admin") { return async (request: FastifyRequest, reply: FastifyReply) => { if (!request.actor) return unauthorized(request, reply); if (role === "admin" && request.actor.role !== "admin") return reply.code(403).send(failure(request.requestId, "AUTHORIZATION_DENIED", "需要管理员权限")); }; }
