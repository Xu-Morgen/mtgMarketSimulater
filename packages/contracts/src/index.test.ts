import { describe, expect, it } from "vitest";
import {
  canonicalizeRequest,
  isValidIdempotencyKey,
  isValidMoney,
  isValidRequestFingerprint,
  isValidRequestId,
  type ApiResponse,
  type BilateralFulfillmentType,
  type DailyWorkFundingStatusDto,
  type DeckPowerSnapshotDto,
  type EconomicFactEvent,
  type PlayerBilateralTradeDto
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

  it("I19F 玩家视角成交 DTO 脱敏对手身份并保留待履约资产字段", () => {
    const buyerView: PlayerBilateralTradeDto = {
      id: "trade-1",
      skuId: "sku-1",
      role: "buyer",
      myOrderId: "my-buy-order",
      quantity: 2,
      executionPrice: { amount: 200, currency: "GAME_CREDIT" },
      fee: { amount: 8, currency: "GAME_CREDIT" },
      pendingFunds: { amount: 408, currency: "GAME_CREDIT" },
      pendingInventoryQuantity: null,
      ruleVersion: "order-matching/v1",
      status: "matched_pending_fulfillment",
      fulfillmentDeadline: "2026-07-29T00:00:00.000Z",
      createdAt: "2026-07-28T00:00:00.000Z",
      updatedAt: "2026-07-28T00:00:00.000Z"
    };
    const sellerView: PlayerBilateralTradeDto = {
      ...buyerView,
      role: "seller",
      myOrderId: "my-sell-order",
      fee: { amount: 8, currency: "GAME_CREDIT" },
      pendingFunds: { amount: 40, currency: "GAME_CREDIT" },
      pendingInventoryQuantity: 2
    };
    const serializedBuyer = JSON.parse(JSON.stringify(buyerView)) as Record<string, unknown>;
    const serializedSeller = JSON.parse(JSON.stringify(sellerView)) as Record<string, unknown>;
    // 不含对手身份或内部 hold 字段。
    expect(serializedBuyer).not.toHaveProperty("buyerUserId");
    expect(serializedBuyer).not.toHaveProperty("sellerUserId");
    expect(serializedBuyer).not.toHaveProperty("buyOrderId");
    expect(serializedBuyer).not.toHaveProperty("sellOrderId");
    expect(serializedBuyer).not.toHaveProperty("buyerFundsHoldId");
    expect(serializedBuyer).not.toHaveProperty("sellerInventoryHoldId");
    expect(serializedBuyer).not.toHaveProperty("sellerDepositHoldId");
    expect(serializedBuyer).toMatchObject({
      role: "buyer",
      myOrderId: "my-buy-order",
      pendingInventoryQuantity: null
    });
    expect(serializedSeller).toMatchObject({ role: "seller", pendingInventoryQuantity: 2 });
  });

  it("I20B 成交 DTO 在履约/取消/待履约三态下均携带待履约期限", () => {
    for (const status of ["matched_pending_fulfillment", "fulfilled", "cancelled"] as const) {
      const view: PlayerBilateralTradeDto = {
        id: "trade-2",
        skuId: "sku-2",
        role: "buyer",
        myOrderId: "order-2",
        quantity: 1,
        executionPrice: { amount: 200, currency: "GAME_CREDIT" },
        fee: { amount: 4, currency: "GAME_CREDIT" },
        pendingFunds: { amount: 204, currency: "GAME_CREDIT" },
        pendingInventoryQuantity: null,
        ruleVersion: "order-matching/v1",
        status,
        fulfillmentDeadline: "2026-07-29T00:00:00.000Z",
        createdAt: "2026-07-28T00:00:00.000Z",
        updatedAt: "2026-07-28T00:00:00.000Z"
      };
      const serialized = JSON.parse(JSON.stringify(view)) as Record<string, unknown>;
      expect(serialized).toMatchObject({ status, fulfillmentDeadline: "2026-07-29T00:00:00.000Z" });
    }
  });

  it("I20F 模拟履约类型固定为 simulated，不引入实体物流状态", () => {
    // BilateralFulfillmentType 是常量联合；本期唯一取值 "simulated" 表示成交后的确认/取消是经济结算，
    // 客户端只能展示服务端返回的类型，不可自行推导或扩展为实体物流状态。
    const fulfillmentType: BilateralFulfillmentType = "simulated";
    expect(fulfillmentType).toBe("simulated");
  });

  it("I24R 强度快照明确来源、版本、输入摘要、可用性与降级原因", () => {
    const primary: DeckPowerSnapshotDto = {
      source: "leyline",
      sourceVersion: "leyline-adapter/v1",
      providerAlgorithmVersion: "undeclared",
      score: 58,
      inputSummarySha256: "a".repeat(64),
      computedAt: "2026-07-29T00:00:00.000Z",
      availability: "available",
      degradationReason: null,
      responseSha256: "b".repeat(64)
    };
    const degraded: DeckPowerSnapshotDto = {
      ...primary,
      source: "local",
      sourceVersion: "local-deck-power/v1",
      providerAlgorithmVersion: null,
      availability: "degraded",
      degradationReason: "provider_timeout",
      responseSha256: null
    };
    expect(JSON.parse(JSON.stringify(primary))).toMatchObject({
      source: "leyline",
      providerAlgorithmVersion: "undeclared",
      availability: "available"
    });
    expect(JSON.parse(JSON.stringify(degraded))).toMatchObject({
      source: "local",
      degradationReason: "provider_timeout",
      responseSha256: null
    });
    const machineLearning: DeckPowerSnapshotDto = {
      ...primary,
      source: "ml",
      sourceVersion: "deck-power-ml/v1.0.0",
      providerAlgorithmVersion: null,
      responseSha256: null
    };
    expect(JSON.parse(JSON.stringify(machineLearning))).toMatchObject({
      source: "ml",
      sourceVersion: "deck-power-ml/v1.0.0"
    });
  });

  it("I23B 每日工作资金状态只承载服务端快照的日期、时区、规则和金额", () => {
    const status: DailyWorkFundingStatusDto = {
      naturalDate: "2026-07-29",
      timezone: "Asia/Shanghai",
      status: "available",
      amount: { amount: 1000, currency: "GAME_CREDIT" },
      ruleVersion: "daily-work-funds/v1",
      openedAt: "2026-07-28T16:00:00.000Z",
      nextEligibleAt: "2026-07-29T16:00:00.000Z",
      claim: null
    };
    expect(JSON.parse(JSON.stringify(status))).toMatchObject({
      status: "available",
      amount: { amount: 1000 }
    });
  });
});
