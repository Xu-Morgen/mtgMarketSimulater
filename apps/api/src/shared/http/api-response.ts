import type { ApiErrorCode, ApiFailure, ApiSuccess } from "@mtg-market/contracts";

export function success<T>(requestId: string, data: T): ApiSuccess<T> {
  return { ok: true, data, meta: { requestId } };
}

export function failure(
  requestId: string,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>
): ApiFailure {
  return { ok: false, error: { code, message, ...(details ? { details } : {}) }, meta: { requestId } };
}
