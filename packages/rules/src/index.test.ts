import { describe, expect, it } from "vitest";
import { INITIAL_FUNDING, INITIAL_FUNDING_RULE_VERSION, resolveInitialFunding } from "./index.js";

describe("初始资金规则", () => {
  it("以版本化、整数最小单位的固定结果解析", () => {
    expect(resolveInitialFunding(INITIAL_FUNDING_RULE_VERSION)).toEqual(INITIAL_FUNDING);
    expect(Number.isSafeInteger(INITIAL_FUNDING.amount)).toBe(true);
  });

  it("拒绝未知规则版本", () => {
    expect(() => resolveInitialFunding("v0")).toThrow("不支持的初始资金规则版本");
  });
});
