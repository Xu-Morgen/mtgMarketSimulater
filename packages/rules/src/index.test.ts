import { describe, expect, it } from "vitest";
import { INITIAL_FUNDING, INITIAL_FUNDING_RULE_VERSION, MARKET_RULE_VERSION, ORDER_PREVIEW_VERSION, ORDER_RULE_VERSION, calculateMarketQuote, calculateOrderFees, isWithinOrderLimitBand, marketQuoteValidUntil, openPack, packSlotProbabilities, propagateMarketPressure, resolveInitialFunding, resolveOrderLimitBand, validateOrderCancellation, type PackRuleInput } from "./index.js";

const PACK_RULE: PackRuleInput = {
  version: "pack/v1",
  pools: [
    { id: "common", rarity: "common", candidates: [{ skuId: "sku-c1", weight: 3 }, { skuId: "sku-c2", weight: 1 }] },
    { id: "rare", rarity: "rare", candidates: [{ skuId: "sku-r1", weight: 1 }] }
  ],
  slots: [{ id: "common-slot", draws: 2, poolWeights: [{ poolId: "common", weight: 9 }, { poolId: "rare", weight: 1 }] }]
};

describe("初始资金规则", () => {
  it("以版本化、整数最小单位的固定结果解析", () => {
    expect(resolveInitialFunding(INITIAL_FUNDING_RULE_VERSION)).toEqual(INITIAL_FUNDING);
    expect(Number.isSafeInteger(INITIAL_FUNDING.amount)).toBe(true);
  });

  it("拒绝未知规则版本", () => {
    expect(() => resolveInitialFunding("v0")).toThrow("不支持的初始资金规则版本");
  });
});

describe("I11B 补充包规则", () => {
  it("以整数概率表和种子确定性产出，且不改写规则输入", () => {
    const before = JSON.stringify(PACK_RULE);
    expect(packSlotProbabilities(PACK_RULE)).toEqual([{ slotId: "common-slot", draws: 2, rarityProbabilities: [{ rarity: "common", probabilityBasisPoints: 9000 }, { rarity: "rare", probabilityBasisPoints: 1000 }] }]);
    const first = openPack({ ...PACK_RULE, randomSeed: "a-server-only-seed" });
    expect(openPack({ ...PACK_RULE, randomSeed: "a-server-only-seed" })).toEqual(first);
    expect(first).toMatchObject({ ruleVersion: "pack/v1", cards: [{ slotId: "common-slot" }, { slotId: "common-slot" }] });
    expect(JSON.stringify(PACK_RULE)).toBe(before);
  });

  it("拒绝概率边界、空候选池和不存在的卡池引用", () => {
    expect(() => packSlotProbabilities({ ...PACK_RULE, pools: [{ ...PACK_RULE.pools[0]!, candidates: [] }, PACK_RULE.pools[1]! ] })).toThrow("候选卡不能为空");
    expect(() => packSlotProbabilities({ ...PACK_RULE, slots: [{ ...PACK_RULE.slots[0]!, poolWeights: [{ poolId: "missing", weight: 1 }] }] })).toThrow("不存在的候选池");
    expect(() => packSlotProbabilities({ ...PACK_RULE, slots: [{ ...PACK_RULE.slots[0]!, poolWeights: [{ poolId: "common", weight: 0 }] }] })).toThrow("必须为正安全整数");
    expect(() => openPack({ ...PACK_RULE, randomSeed: "" })).toThrow("随机种子不能为空");
  });
});

describe("I14B 市场报价规则", () => {
  const input = {
    version: MARKET_RULE_VERSION,
    referencePriceEurCents: 101,
    eurCentToGameCreditBasisPoints: 10_000,
    minimumPrice: 1,
    npcBuySpreadBasisPoints: 1_000,
    npcSellSpreadBasisPoints: 1_000,
    npcFeeBasisPoints: 100,
    factors: [
      { kind: "supply-demand" as const, factorBasisPoints: 10_100, reason: "需求略高" },
      { kind: "liquidity" as const, factorBasisPoints: 9_950, reason: "流动性" }
    ]
  };

  it("以整数欧分、明确 half-up 舍入和版本化因素产生确定报价", () => {
    const first = calculateMarketQuote(input);
    expect(calculateMarketQuote(input)).toEqual(first);
    expect(first).toMatchObject({ ruleVersion: MARKET_RULE_VERSION, marketFactorBasisPoints: 10_050, marketPrice: 102, npcBuyPrice: 90, npcSellPrice: 113 });
    expect(Number.isSafeInteger(first.marketPrice)).toBe(true);
  });

  it("限制总系数、关联传播和非法参数", () => {
    expect(calculateMarketQuote({ ...input, factors: [{ kind: "event", factorBasisPoints: 20_000, reason: "上限" }, { kind: "event", factorBasisPoints: 20_000, reason: "仍然有界" }] }).marketFactorBasisPoints).toBe(20_000);
    expect(propagateMarketPressure(10, 5_000)).toBe(10_125);
    expect(() => calculateMarketQuote({ ...input, referencePriceEurCents: 0 })).toThrow("外部参考价");
    expect(() => calculateMarketQuote({ ...input, npcBuySpreadBasisPoints: 10_000 })).toThrow("NPC 买入价差");
    expect(() => calculateMarketQuote({ ...input, factors: [{ kind: "event", factorBasisPoints: 4_999, reason: "越界" }] })).toThrow("bp");
  });

  it("以固定窗口生成可重放报价有效期，并拒绝非 UTC 时间", () => {
    expect(marketQuoteValidUntil(MARKET_RULE_VERSION, "2026-07-27T00:00:00.000Z")).toBe("2026-07-27T00:15:00.000Z");
    expect(() => marketQuoteValidUntil(MARKET_RULE_VERSION, "2026-07-27")).toThrow("UTC ISO 8601");
  });
});

describe("I18B 双边委托规则", () => {
  it("以市场中间价 ± 限价带计算对称且受最低价保护的范围", () => {
    const band = resolveOrderLimitBand({ marketPrice: 200, minimumPrice: 1, limitPriceBandBasisPoints: 5_000 });
    expect(band).toMatchObject({ ruleVersion: ORDER_RULE_VERSION, marketPrice: 200, min: 100, max: 300 });
    expect(resolveOrderLimitBand({ marketPrice: 200, minimumPrice: 1, limitPriceBandBasisPoints: 5_000 })).toEqual(band);
  });

  it("最低价兜底，避免低价 SKU 因带宽度出现 0 或负值下限", () => {
    expect(resolveOrderLimitBand({ marketPrice: 1, minimumPrice: 1, limitPriceBandBasisPoints: 5_000 }).min).toBe(1);
    expect(() => resolveOrderLimitBand({ marketPrice: 200, minimumPrice: 1, limitPriceBandBasisPoints: 100_001 })).toThrow("bp");
  });

  it("校验限价落在带内，越界或非整数返回 false", () => {
    const band = resolveOrderLimitBand({ marketPrice: 200, minimumPrice: 1, limitPriceBandBasisPoints: 5_000 });
    expect(isWithinOrderLimitBand(200, band)).toBe(true);
    expect(isWithinOrderLimitBand(100, band)).toBe(true);
    expect(isWithinOrderLimitBand(300, band)).toBe(true);
    expect(isWithinOrderLimitBand(99, band)).toBe(false);
    expect(isWithinOrderLimitBand(301, band)).toBe(false);
    expect(isWithinOrderLimitBand(1.5, band)).toBe(false);
  });

  it("买单预占 = 数量*限价 + 全量手续费；卖单只预占保证金，order_fee 不预占", () => {
    const buy = calculateOrderFees({ side: "buy", quantity: 3, limitPrice: 200, marketPrice: 200, orderFeeBasisPoints: 200, fulfillmentDepositBasisPoints: 1_000, minimumPrice: 1 });
    expect(buy).toMatchObject({ ruleVersion: ORDER_RULE_VERSION, unitFee: 4, unitFulfillmentDeposit: 20, orderFee: 12, fulfillmentDeposit: 60, reservedFunds: 612, estimatedAmount: 600 });
    const sell = calculateOrderFees({ side: "sell", quantity: 3, limitPrice: 200, marketPrice: 200, orderFeeBasisPoints: 200, fulfillmentDepositBasisPoints: 1_000, minimumPrice: 1 });
    expect(sell).toMatchObject({ unitFee: 4, unitFulfillmentDeposit: 20, orderFee: 12, fulfillmentDeposit: 60, reservedFunds: 60, estimatedAmount: 600 });
  });

  it("手续费与保证金以 half-up 舍入、最低价兜底", () => {
    expect(calculateOrderFees({ side: "buy", quantity: 1, limitPrice: 1, marketPrice: 3, orderFeeBasisPoints: 333, fulfillmentDepositBasisPoints: 1_111, minimumPrice: 1 })).toMatchObject({ unitFee: 1, unitFulfillmentDeposit: 1, reservedFunds: 2 });
    expect(calculateOrderFees({ side: "buy", quantity: 1, limitPrice: 1, marketPrice: 1, orderFeeBasisPoints: 333, fulfillmentDepositBasisPoints: 1_111, minimumPrice: 1 }).reservedFunds).toBe(2);
  });

  it("拒绝非法数量、负价、越界系数与不安全乘积", () => {
    expect(() => calculateOrderFees({ side: "buy", quantity: 0, limitPrice: 200, marketPrice: 200, orderFeeBasisPoints: 200, fulfillmentDepositBasisPoints: 1_000, minimumPrice: 1 })).toThrow("委托数量");
    expect(() => calculateOrderFees({ side: "buy", quantity: 1, limitPrice: -1, marketPrice: 200, orderFeeBasisPoints: 200, fulfillmentDepositBasisPoints: 1_000, minimumPrice: 1 })).toThrow("限价");
    expect(() => calculateOrderFees({ side: "buy", quantity: 1, limitPrice: 200, marketPrice: 200, orderFeeBasisPoints: 100_001, fulfillmentDepositBasisPoints: 1_000, minimumPrice: 1 })).toThrow("bp");
  });

  it("取消校验只允许 open/partially_filled，其余状态显式拒绝", () => {
    expect(validateOrderCancellation("open")).toEqual({ ok: true, currentStatus: "open" });
    expect(validateOrderCancellation("partially_filled")).toEqual({ ok: true, currentStatus: "partially_filled" });
    expect(validateOrderCancellation("fulfilled")).toEqual({ ok: false, reason: "not_cancellable" });
    expect(validateOrderCancellation("cancelled")).toEqual({ ok: false, reason: "not_cancellable" });
  });

  it("规则版本与预览版本固定且可追溯", () => {
    expect(ORDER_RULE_VERSION).toBe("order/v1");
    expect(ORDER_PREVIEW_VERSION).toBe("order-preview/v1");
  });
});
