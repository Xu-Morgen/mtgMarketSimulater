import argon2 from "argon2";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ApiConfig } from "../../../config/environment.js";
import { signAccessToken, type AccessTokenClaims } from "../domain/token.js";

export interface AuthenticatedUser { id: string; email: string; displayName: string; role: "player" | "admin"; createdAt: string }
interface SessionRecord { id: string; user_id: string; refresh_token_hash: string; csrf_token_hash: string | null; expires_at: string; revoked_at: string | null; role: "player" | "admin"; email: string; display_name: string; created_at: string }

export interface SessionCredentials { accessToken: string; refreshToken: string; csrfToken: string; user: AuthenticatedUser }

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function randomToken(): string { return randomBytes(32).toString("base64url"); }
function isoAfter(now: Date, seconds: number): string { return new Date(now.getTime() + seconds * 1000).toISOString(); }
function userFrom(row: Pick<SessionRecord, "user_id" | "email" | "display_name" | "role" | "created_at">): AuthenticatedUser { return { id: row.user_id, email: row.email, displayName: row.display_name, role: row.role, createdAt: row.created_at }; }

export class AuthService {
  constructor(private readonly database: Database.Database, private readonly config: ApiConfig) {}

  async register(input: { email: string; displayName: string; password: string }, now = new Date()): Promise<SessionCredentials | "email-conflict"> {
    const existing = this.database.prepare("SELECT 1 FROM users WHERE email = ?").get(input.email.toLowerCase());
    if (existing) return "email-conflict";
    const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const id = randomUUID(); const timestamp = now.toISOString();
    try {
      return this.database.transaction(() => {
        this.database.prepare("INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, 'player', ?, ?)").run(id, input.email.toLowerCase(), input.displayName, passwordHash, timestamp, timestamp);
        return this.createSession({ id, email: input.email.toLowerCase(), displayName: input.displayName, role: "player", createdAt: timestamp }, now);
      })();
    } catch (error) {
      if (String(error).includes("UNIQUE constraint failed")) return "email-conflict";
      throw error;
    }
  }

  async login(email: string, password: string, now = new Date()): Promise<SessionCredentials | null> {
    const user = this.database.prepare("SELECT id, email, display_name, password_hash, role, created_at FROM users WHERE email = ?").get(email.toLowerCase()) as { id: string; email: string; display_name: string; password_hash: string; role: "player" | "admin"; created_at: string } | undefined;
    if (!user || !(await argon2.verify(user.password_hash, password))) return null;
    return this.createSession({ id: user.id, email: user.email, displayName: user.display_name, role: user.role, createdAt: user.created_at }, now);
  }

  async rotate(refreshToken: string, csrfToken: string, now = new Date()): Promise<SessionCredentials | "invalid" | "replayed" | "csrf"> {
    const row = this.findSession(refreshToken);
    if (!row) return "invalid";
    if (row.revoked_at) { this.revokeFamily(row.id, now); return "replayed"; }
    if (new Date(row.expires_at) <= now) { this.revoke(row.id, now); return "invalid"; }
    if (!row.csrf_token_hash || sha256(csrfToken) !== row.csrf_token_hash) return "csrf";
    return this.database.transaction(() => {
      this.revoke(row.id, now);
      return this.createSession(userFrom(row), now, row.id);
    })();
  }

  logout(refreshToken: string | undefined, csrfToken: string | undefined, now = new Date()): "ok" | "csrf" {
    if (!refreshToken) return "ok";
    const row = this.findSession(refreshToken);
    if (!row || row.revoked_at) return "ok";
    if (!csrfToken || !row.csrf_token_hash || sha256(csrfToken) !== row.csrf_token_hash) return "csrf";
    this.revoke(row.id, now); return "ok";
  }

  current(claims: AccessTokenClaims): AuthenticatedUser | null {
    const row = this.database.prepare("SELECT u.id AS user_id, u.email, u.display_name, u.role, u.created_at, s.revoked_at, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.user_id = ?").get(claims.sid, claims.sub) as (Pick<SessionRecord, "user_id" | "email" | "display_name" | "role" | "created_at" | "revoked_at" | "expires_at">) | undefined;
    if (!row || row.revoked_at || new Date(row.expires_at) <= new Date()) return null;
    return userFrom(row);
  }

  private createSession(user: AuthenticatedUser, now: Date, rotatedFrom?: string): SessionCredentials {
    const refreshToken = randomToken(); const csrfToken = randomToken(); const sessionId = randomUUID();
    const expiresAt = isoAfter(now, this.config.REFRESH_TOKEN_TTL_SECONDS);
    this.database.prepare("INSERT INTO sessions (id, user_id, refresh_token_hash, csrf_token_hash, expires_at, revoked_at, created_at, rotated_from_session_id) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)").run(sessionId, user.id, sha256(refreshToken), sha256(csrfToken), expiresAt, now.toISOString(), rotatedFrom ?? null);
    const issuedAt = Math.floor(now.getTime() / 1000);
    return { user, refreshToken, csrfToken, accessToken: signAccessToken({ sub: user.id, role: user.role, sid: sessionId, iat: issuedAt, exp: issuedAt + this.config.ACCESS_TOKEN_TTL_SECONDS }, this.config.AUTH_JWT_SECRET) };
  }

  private findSession(refreshToken: string): SessionRecord | undefined {
    return this.database.prepare("SELECT s.id, s.user_id, s.refresh_token_hash, s.csrf_token_hash, s.expires_at, s.revoked_at, u.role, u.email, u.display_name, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_token_hash = ?").get(sha256(refreshToken)) as SessionRecord | undefined;
  }
  private revoke(id: string, now: Date): void { this.database.prepare("UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").run(now.toISOString(), id); }
  /** 刷新令牌遭重放时撤销整条轮换链，阻断被盗令牌继续延展会话。 */
  private revokeFamily(id: string, now: Date): void {
    this.database.prepare(`WITH RECURSIVE family(id) AS (SELECT id FROM sessions WHERE id = ? UNION ALL SELECT s.id FROM sessions s JOIN family f ON s.rotated_from_session_id = f.id) UPDATE sessions SET revoked_at = COALESCE(revoked_at, ?) WHERE id IN (SELECT id FROM family)`).run(id, now.toISOString());
  }
}
