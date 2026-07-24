import type { ApiFailure, ApiResponse, ApiSuccess, UserDto } from "@mtg-market/contracts";
import { loadPublicWebConfig } from "../config/public";

export class ApiClientError extends Error {
  constructor(readonly response: ApiFailure, readonly status: number) { super(response.error.message); this.name = "ApiClientError"; }
  get code() { return this.response.error.code; }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown; accessToken?: string | null; csrfToken?: string | null; idempotencyKey?: string };

function apiUrl(path: string): string { return `${loadPublicWebConfig(process.env).apiBaseUrl}${path}`; }

export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<ApiSuccess<T>> {
  const { body, accessToken, csrfToken, idempotencyKey, headers, ...init } = options;
  const requestInit: RequestInit = {
    ...init,
    credentials: "include",
    headers: {
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...headers
    }
  };
  if (body !== undefined) requestInit.body = JSON.stringify(body);
  const response = await fetch(apiUrl(path), requestInit);
  const payload = await response.json() as ApiResponse<T>;
  if (!payload.ok) throw new ApiClientError(payload, response.status);
  return payload;
}

export interface SessionPayload { accessToken: string; user: UserDto; }
export const authApi = {
  register: (input: { email: string; displayName: string; password: string }, idempotencyKey: string) => apiRequest<SessionPayload>("/v1/auth/register", { method: "POST", body: input, idempotencyKey }),
  login: (input: { email: string; password: string }, idempotencyKey: string) => apiRequest<SessionPayload>("/v1/auth/login", { method: "POST", body: input, idempotencyKey }),
  refresh: (csrfToken: string | null) => apiRequest<SessionPayload>("/v1/auth/refresh", { method: "POST", csrfToken }),
  logout: (csrfToken: string | null, idempotencyKey: string) => apiRequest<{ loggedOut: boolean }>("/v1/auth/logout", { method: "POST", csrfToken, idempotencyKey }),
  session: (accessToken: string) => apiRequest<{ user: UserDto }>("/v1/auth/session", { accessToken })
};
