import { describe, expect, it } from "vitest";
import { INITIAL_FUNDING, INITIAL_FUNDING_RULE_VERSION, MARKET_RULE_VERSION, ORDER_FULFILLMENT_RULE_VERSION, ORDER_MATCH_RULE_VERSION, ORDER_PREVIEW_VERSION, ORDER_RULE_VERSION, calculateMarketQuote, calculateOrderFees, checkSelfTrade, isFulfillmentOverdue, isWithinOrderLimitBand, marketQuoteValidUntil, matchOrders, openPack, packSlotProbabilities, propagateMarketPressure, resolveFulfillmentDeadline, resolveInitialFunding, resolveOrderLimitBand, validateOrderCancellation, validateTradeCancellation, validateTradeFulfillment, type MatchOrderInput, type PackRuleInput } from "./index.js";

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

describe("I19B 撮合规则", () => {
  const baseBuy = (overrides: Partial<MatchOrderInput> & Pick<MatchOrderInput, "id" | "userId">): MatchOrderInput => ({
    limitPrice: 200, remainingQuantity: 5, createdAt: "2026-07-27T00:00:00.000Z", sequence: 1, ...overrides
  });
  const baseSell = (overrides: Partial<MatchOrderInput> & Pick<MatchOrderInput, "id" | "userId">): MatchOrderInput => ({
    limitPrice: 200, remainingQuantity: 5, createdAt: "2026-07-27T00:00:01.000Z", sequence: 2, ...overrides
  });

  it("自成交校验同用户拒绝，不同用户通过", () => {
    expect(checkSelfTrade("u-buy", "u-sell")).toEqual({ ok: true });
    expect(checkSelfTrade("u-same", "u-same")).toEqual({ ok: false, reason: "self_trade" });
    expect(() => checkSelfTrade("", "u-sell")).toThrow("用户");
  });

  it("价格优先：更高买价先成交更低卖价，并按部分成交推进", () => {
    const result = matchOrders({
      ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1,
      buyOrders: [baseBuy({ id: "b-high", userId: "u-b1", limitPrice: 210 }), baseBuy({ id: "b-low", userId: "u-b2", limitPrice: 190 })],
      sellOrders: [baseSell({ id: "s-1", userId: "u-s1", limitPrice: 200, remainingQuantity: 7 })]
    });
    // b-high(210)先于 s-1(200)入簿，b-high 为 maker，成交价=买限价 210；低买 190 低于卖价 200 不成交。
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]).toMatchObject({ buyOrderId: "b-high", sellOrderId: "s-1", executionPrice: 210, quantity: 5 });
    expect(result.remaining).toEqual({ "b-high": 0, "b-low": 5, "s-1": 2 });
  });

  it("时间优先：同价时先入订单簿（createdAt 更早）为 maker，成交价取 maker 限价", () => {
    const result = matchOrders({
      ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1,
      buyOrders: [baseBuy({ id: "b-early", userId: "u-b1", limitPrice: 200, createdAt: "2026-07-27T00:00:00.000Z", sequence: 1 }), baseBuy({ id: "b-late", userId: "u-b2", limitPrice: 200, createdAt: "2026-07-27T00:00:10.000Z", sequence: 3, remainingQuantity: 2 })],
      sellOrders: [baseSell({ id: "s-1", userId: "u-s1", limitPrice: 200, remainingQuantity: 4, createdAt: "2026-07-27T00:00:05.000Z", sequence: 2 })]
    });
    // b-early(00:00) 先于 s-1(00:05)，b-early 是 maker，成交价=200；b-early 5 张被 s-1 吃 4 张剩 1。
    expect(result.legs[0]).toMatchObject({ buyOrderId: "b-early", sellOrderId: "s-1", executionPrice: 200, quantity: 4 });
    // b-early 仍有 1 张，s-1 耗尽；b-late(200) 与剩余 b-early 都不能再成交（无卖盘）。
    expect(result.remaining).toEqual({ "b-early": 1, "b-late": 2, "s-1": 0 });
    expect(result.legs).toHaveLength(1);
  });

  it("成交价取 maker 限价：卖单先入时以卖限价成交", () => {
    const result = matchOrders({
      ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1,
      buyOrders: [baseBuy({ id: "b-1", userId: "u-b1", limitPrice: 210, remainingQuantity: 2, createdAt: "2026-07-27T00:00:10.000Z", sequence: 5 })],
      sellOrders: [baseSell({ id: "s-early", userId: "u-s1", limitPrice: 205, remainingQuantity: 2, createdAt: "2026-07-27T00:00:00.000Z", sequence: 1 })]
    });
    // 卖单先入为 maker，成交价=卖限价 205（而非买限价 210）。
    expect(result.legs[0]).toMatchObject({ executionPrice: 205, quantity: 2 });
  });

  it("createdAt 相同时按 sequence 决定 maker", () => {
    const sameTime = "2026-07-27T00:00:00.000Z";
    const result = matchOrders({
      ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1,
      buyOrders: [baseBuy({ id: "b-1", userId: "u-b1", limitPrice: 210, remainingQuantity: 1, createdAt: sameTime, sequence: 2 })],
      sellOrders: [baseSell({ id: "s-1", userId: "u-s1", limitPrice: 205, remainingQuantity: 1, createdAt: sameTime, sequence: 1 })]
    });
    // sequence 小者为 maker：卖单 seq=1 是 maker，成交价=205。
    expect(result.legs[0]).toMatchObject({ executionPrice: 205 });
  });

  it("部分成交与边界：买限价刚好等于卖限价可成交", () => {
    const result = matchOrders({
      ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1,
      buyOrders: [baseBuy({ id: "b-1", userId: "u-b1", limitPrice: 200, remainingQuantity: 3 })],
      sellOrders: [baseSell({ id: "s-1", userId: "u-s1", limitPrice: 200, remainingQuantity: 5 })]
    });
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]).toMatchObject({ quantity: 3 });
    expect(result.remaining).toEqual({ "b-1": 0, "s-1": 2 });
  });

  it("自成交跳过且双方仍可与其他对手盘成交", () => {
    const result = matchOrders({
      ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1,
      // u-a 同时挂买(200,seq=1,先入 maker)和卖(200,seq=2)：自成交跳过，推进买方游标。
      buyOrders: [baseBuy({ id: "b-a", userId: "u-a", limitPrice: 200, createdAt: "2026-07-27T00:00:00.000Z", sequence: 1 }), baseBuy({ id: "b-b", userId: "u-b", limitPrice: 200, createdAt: "2026-07-27T00:00:05.000Z", sequence: 3, remainingQuantity: 2 })],
      sellOrders: [baseSell({ id: "s-a", userId: "u-a", limitPrice: 200, remainingQuantity: 5, createdAt: "2026-07-27T00:00:02.000Z", sequence: 2 })]
    });
    // b-a 与 s-a 自成交跳过（b-a 是 maker 推进买方游标）；b-b 与 s-a 成交 2 张。
    expect(result.skippedSelfTrade).toEqual([{ buyOrderId: "b-a", sellOrderId: "s-a" }]);
    expect(result.legs).toHaveLength(1);
    expect(result.legs[0]).toMatchObject({ buyOrderId: "b-b", sellOrderId: "s-a", quantity: 2 });
    expect(result.remaining).toEqual({ "b-a": 5, "b-b": 0, "s-a": 3 });
  });

  it("确定性重放：相同输入产生相同 legs、remaining 与 skippedSelfTrade", () => {
    const input = {
      ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1,
      buyOrders: [baseBuy({ id: "b-1", userId: "u-b1", limitPrice: 205 }), baseBuy({ id: "b-2", userId: "u-b2", limitPrice: 200 })],
      sellOrders: [baseSell({ id: "s-1", userId: "u-s1", limitPrice: 200, remainingQuantity: 8 })]
    };
    const first = matchOrders(input);
    expect(matchOrders(input)).toEqual(first);
    expect(first.legs.map((leg) => leg.buyOrderId)).toEqual(["b-1", "b-2"]);
  });

  it("拒绝未知版本、非法数量/限价、坏时间、重复 id 与空输入列表", () => {
    expect(() => matchOrders({ ruleVersion: "v0", minimumPrice: 1, buyOrders: [], sellOrders: [] })).toThrow("撮合规则版本");
    expect(() => matchOrders({ ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: -1, buyOrders: [], sellOrders: [] })).toThrow("最低报价");
    expect(() => matchOrders({ ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1, buyOrders: [baseBuy({ id: "b-1", userId: "u-b1", remainingQuantity: 0 })], sellOrders: [baseSell({ id: "s-1", userId: "u-s1" })] })).toThrow("剩余数量");
    expect(() => matchOrders({ ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1, buyOrders: [baseBuy({ id: "b-1", userId: "u-b1", limitPrice: -1 })], sellOrders: [baseSell({ id: "s-1", userId: "u-s1" })] })).toThrow("限价");
    expect(() => matchOrders({ ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1, buyOrders: [baseBuy({ id: "b-1", userId: "u-b1", createdAt: "2026-07-27" })], sellOrders: [baseSell({ id: "s-1", userId: "u-s1" })] })).toThrow("UTC ISO 8601");
    expect(() => matchOrders({ ruleVersion: ORDER_MATCH_RULE_VERSION, minimumPrice: 1, buyOrders: [baseBuy({ id: "dup", userId: "u-b1" })], sellOrders: [baseSell({ id: "dup", userId: "u-s1" })] })).toThrow("唯一");
  });

  it("规则版本固定且可追溯", () => {
    expect(ORDER_MATCH_RULE_VERSION).toBe("order-matching/v1");
  });
});

describe("I20B 履约规则", () => {
  it("按 ttl_seconds 从撮合时刻派生 UTC ISO 8601 待履约期限", () => {
    const deadline = resolveFulfillmentDeadline(ORDER_FULFILLMENT_RULE_VERSION, 86_400, "2026-07-28T00:00:00.000Z");
    expect(deadline).toBe("2026-07-29T00:00:00.000Z");
  });

  it("相同输入产生相同期限（可重放）", () => {
    const a = resolveFulfillmentDeadline(ORDER_FULFILLMENT_RULE_VERSION, 3_600, "2026-07-28T12:00:00.000Z");
    const b = resolveFulfillmentDeadline(ORDER_FULFILLMENT_RULE_VERSION, 3_600, "2026-07-28T12:00:00.000Z");
    expect(a).toBe(b);
    expect(a).toBe("2026-07-28T13:00:00.000Z");
  });

  it("拒绝未知版本、非正 ttl 与坏时间", () => {
    expect(() => resolveFulfillmentDeadline("v0", 60, "2026-07-28T00:00:00.000Z")).toThrow("履约规则版本");
    expect(() => resolveFulfillmentDeadline(ORDER_FULFILLMENT_RULE_VERSION, 0, "2026-07-28T00:00:00.000Z")).toThrow("委托有效期");
    expect(() => resolveFulfillmentDeadline(ORDER_FULFILLMENT_RULE_VERSION, 60, "2026-07-28")).toThrow("UTC ISO 8601");
  });

  it("仅 matched_pending_fulfillment 可确认履约或取消履约", () => {
    expect(validateTradeFulfillment("matched_pending_fulfillment")).toEqual({ ok: true, currentStatus: "matched_pending_fulfillment" });
    expect(validateTradeFulfillment("fulfilled")).toEqual({ ok: false, reason: "not_fulfillable" });
    expect(validateTradeFulfillment("cancelled")).toEqual({ ok: false, reason: "not_fulfillable" });
    expect(validateTradeCancellation("matched_pending_fulfillment")).toEqual({ ok: true, currentStatus: "matched_pending_fulfillment" });
    expect(validateTradeCancellation("fulfilled")).toEqual({ ok: false, reason: "not_cancellable" });
    expect(validateTradeCancellation("cancelled")).toEqual({ ok: false, reason: "not_cancellable" });
  });

  it("isFulfillmentOverdue 严格按字符串比较且校验时间格式", () => {
    expect(isFulfillmentOverdue(ORDER_FULFILLMENT_RULE_VERSION, "2026-07-29T00:00:00.000Z", "2026-07-29T00:00:00.000Z")).toBe(true);
    expect(isFulfillmentOverdue(ORDER_FULFILLMENT_RULE_VERSION, "2026-07-29T00:00:00.000Z", "2026-07-28T23:59:59.999Z")).toBe(false);
    expect(() => isFulfillmentOverdue("v0", "2026-07-29T00:00:00.000Z", "2026-07-29T00:00:00.000Z")).toThrow("履约规则版本");
    expect(() => isFulfillmentOverdue(ORDER_FULFILLMENT_RULE_VERSION, "2026-07-29", "2026-07-29T00:00:00.000Z")).toThrow("待履约期限");
  });

  it("履约规则版本固定且可追溯", () => {
    expect(ORDER_FULFILLMENT_RULE_VERSION).toBe("order-fulfillment/v1");
  });
});
