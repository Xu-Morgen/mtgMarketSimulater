import { randomUUID } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { isValidRequestId } from "@mtg-market/contracts";

export const REQUEST_ID_HEADER = "x-request-id";

export function resolveRequestId(request: FastifyRequest): string {
  const supplied = request.headers[REQUEST_ID_HEADER];
  const candidate = Array.isArray(supplied) ? supplied[0] : supplied;
  return candidate && isValidRequestId(candidate) ? candidate : randomUUID();
}
