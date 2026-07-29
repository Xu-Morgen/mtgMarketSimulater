import { describe, expect, it } from "vitest";
import { I24R_DECK_FIXTURES, I24R_LOCAL_RESULTS } from "./local-deck-power-fixtures.js";
import {
  LOCAL_DECK_POWER_RULE_VERSION_V2,
  calculateLocalDeckPower,
  compareLocalDeckPower,
  localDeckPowerInputSha256
} from "./local-deck-power.js";

describe("I24R 本地 Commander 强度研究规则", () => {
  it("对固定样本只依赖本地元数据与规范化卡表，结果和输入摘要可重复", () => {
    const sample = I24R_DECK_FIXTURES[2]!;
    const first = calculateLocalDeckPower(sample.input);
    const reordered = calculateLocalDeckPower({
      ...sample.input,
      cards: [...sample.input.cards].reverse(),
      normalizedDecklist: [...sample.input.normalizedDecklist].reverse()
    });
    expect(first).toEqual(reordered);
    expect(first).toMatchObject({
      ruleVersion: "local-deck-power/v1",
      metadataVersion: "i24r-controlled-commander-pool/v1",
      score: 60
    });
    expect(first.contributions.find((entry) => entry.tag === "tutor")).toMatchObject({
      matchedCards: 1,
      rawPoints: 6,
      cappedPoints: 6,
      cap: 24
    });
    expect(first.inputSummarySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(localDeckPowerInputSha256(sample.input)).toBe(first.inputSummarySha256);
  });

  it("以 SHA-256 保存规范化输入摘要，避免不同报名输入共享快照", () => {
    expect(
      localDeckPowerInputSha256({
        ruleVersion: "local-deck-power/v1",
        metadataVersion: "metadata/v1",
        normalizedDecklist: [{ cardId: "card-a", quantity: 1 }]
      })
    ).toBe("bb4c2b29e4b165d119beafcca6c35647e1f9c0b0dc47121fc4fa811e5b838f82");
  });

  it("使用明确整数贡献和上限；极端标签密度不会超出 100 分", () => {
    const competitive = I24R_LOCAL_RESULTS.find((sample) => sample.id === "competitive")!.result;
    expect(competitive.score).toBe(100);
    expect(competitive.contributions.find((entry) => entry.tag === "combo-piece")).toMatchObject({
      matchedCards: 3,
      rawPoints: 15,
      cappedPoints: 10,
      cap: 10
    });
    expect(competitive.contributions.find((entry) => entry.tag === "win-condition")).toMatchObject({
      matchedCards: 5,
      rawPoints: 15,
      cappedPoints: 9,
      cap: 9
    });
  });

  it("拒绝非法输入、重复元数据和缺失本地元数据", () => {
    const sample = I24R_DECK_FIXTURES[0]!;
    expect(() =>
      calculateLocalDeckPower({ ...sample.input, ruleVersion: "local-deck-power/v0" })
    ).toThrow("不支持的本地卡组强度规则版本");
    expect(() => calculateLocalDeckPower({ ...sample.input, normalizedDecklist: [] })).toThrow(
      "规范化卡表不能为空"
    );
    expect(() =>
      calculateLocalDeckPower({
        ...sample.input,
        normalizedDecklist: [{ cardId: sample.input.cards[0]!.cardId, quantity: 0 }]
      })
    ).toThrow("必须为正安全整数");
    expect(() =>
      calculateLocalDeckPower({
        ...sample.input,
        normalizedDecklist: [{ cardId: "missing-local-card", quantity: 1 }]
      })
    ).toThrow("缺少本地卡牌元数据");
    expect(() =>
      calculateLocalDeckPower({
        ...sample.input,
        cards: [...sample.input.cards, sample.input.cards[0]!]
      })
    ).toThrow("元数据卡牌 ID 重复");
  });

  it("参数版本切换保留版本与输入摘要的可审计差异，不改写 v1 重放结果", () => {
    const sample = I24R_DECK_FIXTURES[4]!;
    const v1 = calculateLocalDeckPower(sample.input);
    const v2 = calculateLocalDeckPower({
      ...sample.input,
      ruleVersion: LOCAL_DECK_POWER_RULE_VERSION_V2
    });
    expect(v2.ruleVersion).toBe(LOCAL_DECK_POWER_RULE_VERSION_V2);
    expect(v2.inputSummarySha256).not.toBe(v1.inputSummarySha256);
    expect(v2.score).toBeGreaterThan(v1.score);
    expect(calculateLocalDeckPower(sample.input)).toEqual(v1);
  });

  it("以已保存 Leyline 响应进行覆盖率、稳定性、单调性、极端偏差与可解释性对照", () => {
    const comparison = compareLocalDeckPower(
      I24R_LOCAL_RESULTS.map((sample) => ({
        id: sample.id,
        localScore: sample.result.score,
        leylinePower: sample.leyline.scores.power,
        metadataComplete:
          sample.leyline.resolvedCount === 100 && sample.leyline.missingCards.length === 0
      }))
    );
    expect(I24R_LOCAL_RESULTS.map((sample) => sample.result.score)).toEqual([
      28, 38, 60, 65, 87, 100
    ]);
    expect(comparison).toEqual({
      sampleCount: 6,
      coveredCount: 6,
      coverageBasisPoints: 10_000,
      meanAbsoluteError: 6,
      maxAbsoluteError: 12,
      concordantPairs: 15,
      comparablePairs: 15,
      monotonicityBasisPoints: 10_000,
      lowExtremeMeanAbsoluteError: 6,
      highExtremeMeanAbsoluteError: 10
    });
    for (const sample of I24R_LOCAL_RESULTS)
      expect(sample.result.contributions.length).toBeGreaterThan(1);
  });
});
