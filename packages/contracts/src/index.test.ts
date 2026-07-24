import { describe, expect, it } from "vitest";
import {
  canonicalizeRequest,
  isValidIdempotencyKey,
  isValidMoney,
  isValidRequestFingerprint,
  isValidRequestId,
  type ApiResponse,
  type EconomicFactEvent
} from "./index.js";

describe("共享契约", () => {
  it("能稳定序列化等价但键顺序不同的请求", () => {
    expect(canonicalizeRequest({ quantity: 2, skuId: "sku-1" })).toBe(
      canonicalizeRequest({ skuId: "sku-1", quantity: 2 })
    );
  });

  it("拒绝不能安全序列化的请求值", () => {
    expect(() => canonicalizeRequest({ value: Number.NaN })).toThrow("非有限数字");
    expect(() => canonicalizeRequest(undefined)).toThrow("JSON 值");
    expect(() => canonicalizeRequest(new Date())).toThrow("普通 JSON 对象");
  });

  it("校验请求 ID、幂等键、指纹和整数金额", () => {
    expect(isValidRequestId("req_20260724_01")).toBe(true);
    expect(isValidRequestId("short")).toBe(false);
    expect(isValidIdempotencyKey("idem_20260724_01")).toBe(true);
    expect(isValidIdempotencyKey("bad key")).toBe(false);
    expect(isValidRequestFingerprint("a".repeat(64))).toBe(true);
    expect(isValidRequestFingerprint("a".repeat(63))).toBe(false);
    expect(isValidMoney({ amount: 100, currency: "GAME_CREDIT" })).toBe(true);
    expect(isValidMoney({ amount: 0.1, currency: "GAME_CREDIT" })).toBe(false);
    expect(isValidMoney({ amount: -1, currency: "GAME_CREDIT" })).toBe(false);
  });

  it("保留冲突响应和已结算事实事件的可序列化形状", () => {
    const conflict: ApiResponse<never> = {
      ok: false,
      error: { code: "IDEMPOTENCY_CONFLICT", message: "同一键对应不同请求" },
      meta: { requestId: "req_20260724_01" }
    };
    const event: EconomicFactEvent = {
      id: "event-1",
      type: "pack.opened",
      version: 1,
      occurredAt: "2026-07-24T00:00:00.000Z",
      correlationId: "pack-open-1",
      payload: {
        userId: "user-1",
        packId: "pack-1",
        packRuleVersion: "v1",
        spent: { amount: 500, currency: "GAME_CREDIT" },
        received: [{ skuId: "sku-1", quantity: 1 }]
      }
    };

    expect(JSON.parse(JSON.stringify(conflict))).toMatchObject({
      error: { code: "IDEMPOTENCY_CONFLICT" }
    });
    expect(JSON.parse(JSON.stringify(event))).toMatchObject({ type: "pack.opened", version: 1 });
  });
});
