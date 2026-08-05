import { describe, expect, it } from "vitest";
import {
  LEVEL_RULE_VERSION,
  MAX_LEVEL,
  resolveLevelCapabilities,
  resolveLevelExperience,
  resolveLevelUpReward
} from "./level-rules.js";

function resolve(peakNetWorthAmount: number, settledTrades = 0, setsAt80 = 0, setsAt100 = 0) {
  return resolveLevelExperience({ ruleVersion: LEVEL_RULE_VERSION, peakNetWorthAmount, settledTrades, collectionCompletion: { setsAt80, setsAt100 } });
}

describe("I35B 等级/声望纯规则", () => {
  it("经验由净资产/交易/系列完成度派生且单调", () => {
    expect(resolve(0)).toMatchObject({ totalXp: 0, level: 1, title: "见习收藏家", nextLevelXp: 200, progressBasisPoints: 0 });
    expect(resolve(10_000, 0)).toMatchObject({ totalXp: 200, level: 2 });
    expect(resolve(0, 40)).toMatchObject({ totalXp: 200, level: 2 });
    // 净资产峰值每 1000 计 20 经验（向下取整），交易每张 5，系列 80% 每系列 10、100% 每系列 50。
    expect(resolve(5_999, 0)).toMatchObject({ totalXp: 100 });
    expect(resolve(6_000, 0)).toMatchObject({ totalXp: 120 });
    expect(resolve(0, 0, 1, 1)).toMatchObject({ totalXp: 60 });
  });

  it("等级阈值与封顶：达到累计经验即升级，封顶后仍累计经验", () => {
    expect(resolve(0, 100)).toMatchObject({ totalXp: 500, level: 3, title: "卡牌行家" });
    expect(resolve(0, 400)).toMatchObject({ totalXp: 2000, level: 5, title: "传奇收藏家", nextLevelXp: null, progressBasisPoints: 10000 });
    expect(resolve(10_000_000, 100)).toMatchObject({ level: MAX_LEVEL });
  });

  it("能力表：等级 1 默认与引入等级系统前一致，更高等级解锁批量开包与交易倍率", () => {
    expect(resolveLevelCapabilities(1)).toEqual({ npcDailyTradeMultiplier: 1, bulkPackMax: 10 });
    expect(resolveLevelCapabilities(2)).toEqual({ npcDailyTradeMultiplier: 1, bulkPackMax: 50 });
    expect(resolveLevelCapabilities(3)).toEqual({ npcDailyTradeMultiplier: 2, bulkPackMax: 100 });
    expect(resolveLevelCapabilities(4)).toEqual({ npcDailyTradeMultiplier: 3, bulkPackMax: 100 });
    expect(resolveLevelCapabilities(5)).toEqual({ npcDailyTradeMultiplier: 5, bulkPackMax: 100 });
    // 超过封顶级按封顶能力处理。
    expect(resolveLevelCapabilities(99)).toEqual(resolveLevelCapabilities(MAX_LEVEL));
  });

  it("升级奖励表：2–5 级各发一次性 GAME_CREDIT，其余等级为 null", () => {
    expect(resolveLevelUpReward(LEVEL_RULE_VERSION, 2)).toBe(200);
    expect(resolveLevelUpReward(LEVEL_RULE_VERSION, 3)).toBe(300);
    expect(resolveLevelUpReward(LEVEL_RULE_VERSION, 4)).toBe(500);
    expect(resolveLevelUpReward(LEVEL_RULE_VERSION, 5)).toBe(1000);
    expect(resolveLevelUpReward(LEVEL_RULE_VERSION, 1)).toBeNull();
    expect(resolveLevelUpReward(LEVEL_RULE_VERSION, 6)).toBeNull();
  });

  it("非法输入抛 RangeError", () => {
    expect(() => resolve(-1)).toThrow(RangeError);
    expect(() => resolve(0, -1)).toThrow(RangeError);
    expect(() => resolve(0, 0, -1)).toThrow(RangeError);
    expect(() => resolveLevelCapabilities(0)).toThrow(RangeError);
    expect(() => resolveLevelExperience({ ruleVersion: "unknown/v1", peakNetWorthAmount: 0, settledTrades: 0, collectionCompletion: { setsAt80: 0, setsAt100: 0 } })).toThrow(RangeError);
    expect(() => resolveLevelUpReward("unknown/v1", 2)).toThrow(RangeError);
  });

  it("确定性：同一输入可重放得到相同结果", () => {
    const input = { ruleVersion: LEVEL_RULE_VERSION, peakNetWorthAmount: 7_500, settledTrades: 23, collectionCompletion: { setsAt80: 2, setsAt100: 1 } };
    expect(resolveLevelExperience(input)).toEqual(resolveLevelExperience(input));
  });
});
