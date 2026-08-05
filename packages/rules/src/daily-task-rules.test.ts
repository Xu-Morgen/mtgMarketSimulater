import { describe, expect, it } from "vitest";
import {
  applyTaskAdvance,
  DAILY_TASK_RULE_VERSION,
  resolveDailyTaskDefinitions,
  type DailyTaskDefinition
} from "./daily-task-rules.js";

const open3 = resolveDailyTaskDefinitions(DAILY_TASK_RULE_VERSION).find((definition) => definition.id === "daily-open-3/v1")!;
const trade10 = resolveDailyTaskDefinitions(DAILY_TASK_RULE_VERSION).find((definition) => definition.id === "daily-trade-10/v1")!;
const collection2000 = resolveDailyTaskDefinitions(DAILY_TASK_RULE_VERSION).find((definition) => definition.id === "daily-collection-2000/v1")!;
const set80 = resolveDailyTaskDefinitions(DAILY_TASK_RULE_VERSION).find((definition) => definition.id === "weekly-set-80/v1")!;

function apply(definition: DailyTaskDefinition, previousValue: number, contribution: number, state = false) {
  return applyTaskAdvance({ ruleVersion: DAILY_TASK_RULE_VERSION, definition, previousValue, profile: { contribution, state } });
}

describe("I35B 每日/每周任务纯规则", () => {
  it("定义解析：固定 6 条每日/每周任务，目标与奖励与迁移一致", () => {
    const definitions = resolveDailyTaskDefinitions(DAILY_TASK_RULE_VERSION);
    expect(definitions).toHaveLength(6);
    expect(definitions.map((definition) => definition.id)).toEqual([
      "daily-open-3/v1", "daily-trade-10/v1", "daily-sell-1/v1", "daily-collection-2000/v1", "weekly-tournament-3/v1", "weekly-set-80/v1"
    ]);
    expect(open3).toMatchObject({ period: "daily", metricType: "pack.open", targetAmount: 3, rewardAmount: 100 });
    expect(set80).toMatchObject({ period: "weekly", metricType: "set.completion", targetAmount: 8000, rewardAmount: 500 });
  });

  it("计数型指标累加贡献值，达到目标即 claimable", () => {
    const first = apply(open3, 0, 1);
    expect(first).toEqual({ newValue: 1, achieved: false });
    const second = apply(open3, 1, 2);
    expect(second).toEqual({ newValue: 3, achieved: true });
    expect(apply(trade10, 9, 1)).toEqual({ newValue: 10, achieved: true });
    expect(apply(trade10, 10, 5)).toEqual({ newValue: 15, achieved: true });
  });

  it("状态型指标以 max(现有, 样本) 收敛，卖出/消费后进度不回退", () => {
    expect(apply(collection2000, 0, 2500, true)).toEqual({ newValue: 2500, achieved: true });
    expect(apply(collection2000, 2500, 800, true)).toEqual({ newValue: 2500, achieved: true });
    expect(apply(collection2000, 2500, 3000, true)).toEqual({ newValue: 3000, achieved: true });
    expect(apply(set80, 0, 7000, true)).toEqual({ newValue: 7000, achieved: false });
    expect(apply(set80, 7000, 8000, true)).toEqual({ newValue: 8000, achieved: true });
  });

  it("非法输入抛 RangeError，绝不静默回退", () => {
    expect(() => apply(open3, -1, 1)).toThrow(RangeError);
    expect(() => apply(open3, 0, -1)).toThrow(RangeError);
    expect(() => apply(open3, 0, 1.5)).toThrow(RangeError);
    expect(() => apply(open3, Number.NaN, 1)).toThrow(RangeError);
  });

  it("未知规则版本抛 RangeError", () => {
    expect(() => resolveDailyTaskDefinitions("unknown/v1")).toThrow(RangeError);
    expect(() => applyTaskAdvance({ ruleVersion: "unknown/v1", definition: open3, previousValue: 0, profile: { contribution: 1, state: false } })).toThrow(RangeError);
  });

  it("确定性：同一输入可重放得到相同结果", () => {
    const input = { ruleVersion: DAILY_TASK_RULE_VERSION, definition: trade10, previousValue: 4, profile: { contribution: 3, state: false } };
    expect(applyTaskAdvance(input)).toEqual(applyTaskAdvance(input));
  });
});
