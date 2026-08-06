import { describe, expect, it } from "vitest";
import {
  applyOnboardingAdvance,
  isViewEventStepMatch,
  ONBOARDING_REWARD,
  ONBOARDING_RULE_VERSION,
  resolveOnboardingReward,
  resolveOnboardingSteps
} from "./onboarding-rules.js";

describe("I36B/I36F 新手引导纯规则", () => {
  it("解析版本化步骤定义：九步覆盖创建、经济、收藏、合法组卡、报名与赛果，fact/profile/view_event 三类完成判定齐备", () => {
    const steps = resolveOnboardingSteps(ONBOARDING_RULE_VERSION);
    expect(steps.map((step) => step.id)).toEqual([
      "create-archive",
      "claim-work-funds",
      "open-first-pack",
      "view-price-history",
      "complete-first-npc-trade",
      "unlock-collection-album",
      "create-first-deck",
      "first-tournament-registration",
      "finish-first-tournament"
    ]);
    expect(steps.every((step) => step.title.length > 0 && step.description.length > 0 && step.href.startsWith("/") && step.skippable)).toBe(true);
    expect(steps[0]).toMatchObject({ source: "profile", profileKey: "archive_created" });
    expect(steps.find((step) => step.id === "open-first-pack")).toMatchObject({ source: "fact", factEventType: "pack.opened", goal: 1 });
    expect(steps.find((step) => step.id === "complete-first-npc-trade")).toMatchObject({ source: "fact", factEventType: "npc.trade.settled", goal: 1 });
    expect(steps.find((step) => step.id === "view-price-history")).toMatchObject({ source: "view_event", targetPath: "/market/history" });
    expect(steps.find((step) => step.id === "claim-work-funds")).toMatchObject({ source: "profile", profileKey: "work_funds_claimed" });
    expect(steps.find((step) => step.id === "unlock-collection-album")).toMatchObject({ source: "view_event", targetPath: "/collection/album" });
    expect(steps.find((step) => step.id === "create-first-deck")).toMatchObject({ source: "profile", profileKey: "legal_deck_saved" });
    expect(steps.find((step) => step.id === "first-tournament-registration")).toMatchObject({ source: "profile", profileKey: "tournament_registered" });
    expect(steps.find((step) => step.id === "finish-first-tournament")).toMatchObject({ source: "view_event", targetPath: "/tournaments/result" });
    expect(new Set(steps.map((step) => step.id)).size).toBe(steps.length);
  });

  it("未知规则版本抛 RangeError；奖励金额固定且版本解析一致", () => {
    expect(() => resolveOnboardingSteps("onboarding/v4")).toThrow(RangeError);
    expect(() => resolveOnboardingReward("onboarding/v4")).toThrow(RangeError);
    expect(ONBOARDING_REWARD).toEqual({ amount: 500, currency: "GAME_CREDIT" });
    expect(resolveOnboardingReward(ONBOARDING_RULE_VERSION)).toEqual(ONBOARDING_REWARD);
  });

  it("事实步骤推进：累加到目标即完成；非法输入抛 RangeError；重复事实只累加不翻倍判定", () => {
    const steps = resolveOnboardingSteps(ONBOARDING_RULE_VERSION);
    const packStep = steps.find((step) => step.id === "open-first-pack")!;
    const first = applyOnboardingAdvance({ ruleVersion: ONBOARDING_RULE_VERSION, step: packStep, previousValue: 0, contribution: 1 });
    expect(first).toEqual({ newValue: 1, achieved: true });
    // 重放同一事实（contribution 1）从已达成状态推进：进度继续累加，完成判定保持。
    const replay = applyOnboardingAdvance({ ruleVersion: ONBOARDING_RULE_VERSION, step: packStep, previousValue: 1, contribution: 1 });
    expect(replay).toEqual({ newValue: 2, achieved: true });
    expect(() => applyOnboardingAdvance({ ruleVersion: ONBOARDING_RULE_VERSION, step: packStep, previousValue: 0, contribution: -1 })).toThrow(RangeError);
    expect(() => applyOnboardingAdvance({ ruleVersion: ONBOARDING_RULE_VERSION, step: packStep, previousValue: -1, contribution: 1 })).toThrow(RangeError);
    expect(() => applyOnboardingAdvance({ ruleVersion: "onboarding/v4", step: packStep, previousValue: 0, contribution: 1 })).toThrow(RangeError);
  });

  it("profile/view_event 步骤不可累加推进，view_event 路径必须与定义匹配", () => {
    const steps = resolveOnboardingSteps(ONBOARDING_RULE_VERSION);
    const profileStep = steps.find((step) => step.id === "claim-work-funds")!;
    expect(() => applyOnboardingAdvance({ ruleVersion: ONBOARDING_RULE_VERSION, step: profileStep, previousValue: 0, contribution: 1 })).toThrow(RangeError);
    const viewStep = steps.find((step) => step.id === "view-price-history")!;
    expect(isViewEventStepMatch(viewStep, "/market/history")).toBe(true);
    expect(isViewEventStepMatch(viewStep, "/market")).toBe(false);
    expect(isViewEventStepMatch(profileStep, "/dashboard")).toBe(false);
  });
});
