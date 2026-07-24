import { createHmac, timingSafeEqual } from "node:crypto";

export interface AccessTokenClaims {
  sub: string;
  role: "player" | "admin";
  sid: string;
  exp: number;
  iat: number;
}

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function signature(input: string, secret: string): string {
  return createHmac("sha256", secret).update(input).digest("base64url");
}

/** 仅签发短期、服务端验证的访问令牌；刷新凭据始终只保存在 HttpOnly Cookie。 */
export function signAccessToken(claims: AccessTokenClaims, secret: string): string {
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify(claims));
  const input = `${header}.${payload}`;
  return `${input}.${signature(input, secret)}`;
}

export function verifyAccessToken(token: string, secret: string, now: Date): AccessTokenClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const input = `${parts[0]}.${parts[1]}`;
  const expected = signature(input, secret);
  if (expected.length !== parts[2].length || !timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]))) return null;
  try {
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")) as { alg?: string; typ?: string };
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Partial<AccessTokenClaims>;
    const exp = claims.exp; const iat = claims.iat;
    if (header.alg !== "HS256" || header.typ !== "JWT" || typeof claims.sub !== "string" || typeof claims.sid !== "string" || (claims.role !== "player" && claims.role !== "admin") || typeof exp !== "number" || !Number.isInteger(exp) || typeof iat !== "number" || !Number.isInteger(iat) || exp <= Math.floor(now.getTime() / 1000)) return null;
    return claims as AccessTokenClaims;
  } catch {
    return null;
  }
}
