import type { ApiFailure, ApiResponse, ApiSuccess, UserDto } from "@mtg-market/contracts";
import { loadPublicWebConfig, publicWebEnvironment } from "../config/public";

export class ApiClientError extends Error {
  constructor(readonly response: ApiFailure, readonly status: number) { super(response.error.message); this.name = "ApiClientError"; }
  get code() { return this.response.error.code; }
}

type RequestOptions = Omit<RequestInit, "body"> & { body?: unknown; accessToken?: string | null; csrfToken?: string | null; idempotencyKey?: string };

function apiUrl(path: string): string { return `${loadPublicWebConfig(publicWebEnvironment).apiBaseUrl}${path}`; }

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

/**
 * 受控文件下载：服务端以 `attachment` 流返回由其生成的备份/导出文件。
 * 浏览器只把响应体保存为 Blob 并落盘；文件名来自服务端记录（调用方传入），
 * 绝不读取、拼装或推导源库绝对路径、`EXPORT_DIR`/`BACKUP_DIR` 或数据库名。
 * 注意：`Content-Disposition` 属于浏览器禁止 JS 读取的响应头，故文件名必须由
 * 调用方从服务端记录 DTO 提供，不从响应头解析。
 * 失败（如 404 过期/越权、403 无权限）抛出与 JSON 路由一致的 `ApiClientError`。
 */
export async function downloadAttachment(path: string, options: Omit<RequestOptions, "body"> = {}, suggestedFileName?: string): Promise<{ fileName: string; sizeBytes: number }> {
  const { accessToken, csrfToken, idempotencyKey, headers, ...init } = options;
  const response = await fetch(apiUrl(path), {
    ...init,
    credentials: "include",
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...headers
    }
  });
  if (!response.ok) {
    // 服务端错误仍以统一响应包络返回 JSON；尝试解析以保留错误码语义。
    let payload: ApiResponse<unknown> | null = null;
    try { payload = await response.json() as ApiResponse<unknown>; } catch { payload = null; }
    if (payload && !payload.ok) throw new ApiClientError(payload, response.status);
    // 无法解析 JSON 时退化为通用内部错误码，仍由 ApiClientError 携带 HTTP 状态。
    throw new ApiClientError({ ok: false, error: { code: "INTERNAL_ERROR", message: "文件下载失败，请稍后重试。" }, meta: { requestId: "download" } }, response.status);
  }
  const blob = await response.blob();
  const fileName = sanitizeFileName(suggestedFileName) ?? "download";
  triggerBrowserDownload(blob, fileName);
  return { fileName, sizeBytes: blob.size };
}

/** 仅清洗文件名中的非法字符；文件名本身来自服务端记录，浏览器不推导路径。 */
function sanitizeFileName(name: string | undefined): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  // 移除路径分隔符与引号，并丢弃其余控制字符，防止伪造路径；保留扩展名。
  const cleaned = trimmed.replace(/["\\/]/g, "_").split("").filter((char) => char.charCodeAt(0) >= 32).join("");
  return cleaned.slice(0, 200) || null;
}

function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 释放对象 URL，避免内存泄漏；略作延迟以确保下载已发起。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export interface SessionPayload { accessToken: string; user: UserDto; }
export const authApi = {
  register: (input: { email: string; displayName: string; password: string }, idempotencyKey: string) => apiRequest<SessionPayload>("/v1/auth/register", { method: "POST", body: input, idempotencyKey }),
  login: (input: { email: string; password: string }, idempotencyKey: string) => apiRequest<SessionPayload>("/v1/auth/login", { method: "POST", body: input, idempotencyKey }),
  refresh: (csrfToken: string | null) => apiRequest<SessionPayload>("/v1/auth/refresh", { method: "POST", csrfToken }),
  logout: (csrfToken: string | null, idempotencyKey: string) => apiRequest<{ loggedOut: boolean }>("/v1/auth/logout", { method: "POST", csrfToken, idempotencyKey }),
  session: (accessToken: string) => apiRequest<{ user: UserDto }>("/v1/auth/session", { accessToken })
};
