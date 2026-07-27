import { describe, expect, it } from "vitest";
import { INITIAL_FUNDING, INITIAL_FUNDING_RULE_VERSION, MARKET_RULE_VERSION, calculateMarketQuote, openPack, packSlotProbabilities, propagateMarketPressure, resolveInitialFunding, type PackRuleInput } from "./index.js";

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
});
