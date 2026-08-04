import { describe, expect, it } from "vitest";
import {
  ACHIEVEMENT_RULE_VERSION,
  evaluateCollectionAchievements,
  evaluateDeckAchievements,
  evaluateRewardRisk,
  evaluateSetCompletionAchievements,
  evaluateTournamentAchievements,
  resolveFirstAchievements
} from "./achievement-rules.js";

const TOURNAMENT_IDS = ["first-tournament/v1", "tournament-champion/v1", "win-streak-3/v1"];
const DECK_IDS = ["mono-color-commander/v1", "series-pilot/v1"];
const COLLECTION_IDS = ["collection-10/v1", "collection-50/v1", "collection-100/v1"];
const SET_COMPLETION_IDS = ["set-completion-80/v1", "set-completion-100/v1"];

describe("I26B achievement-rules", () => {
  describe("resolveFirstAchievements", () => {
    it("returns a controlled, versioned definition set that is deterministic", () => {
      const first = resolveFirstAchievements(ACHIEVEMENT_RULE_VERSION);
      const second = resolveFirstAchievements(ACHIEVEMENT_RULE_VERSION);
      expect(first).toEqual(second);
      expect(first.map((definition) => definition.id)).toEqual([
        "first-tournament/v1",
        "tournament-champion/v1",
        "win-streak-3/v1",
        "mono-color-commander/v1",
        "series-pilot/v1",
        "collection-10/v1",
        "collection-50/v1",
        "collection-100/v1",
        "set-completion-80/v1",
        "set-completion-100/v1"
      ]);
      for (const definition of first) {
        expect(definition.ruleVersion).toBe(ACHIEVEMENT_RULE_VERSION);
        expect(definition.display.title.length).toBeGreaterThan(0);
      }
    });

    it("rejects unknown rule versions", () => {
      expect(() => resolveFirstAchievements("achievement/v2")).toThrow("不支持的成就规则版本");
    });

    it("packs reward specs consistently with tournament reward detail semantics", () => {
      const credit = resolveFirstAchievements(ACHIEVEMENT_RULE_VERSION).find((definition) => definition.id === "first-tournament/v1")!;
      expect(credit.reward).toEqual({ kind: "GAME_CREDIT", amount: 200, packId: null, skuId: null, badgeId: null });
      const badge = resolveFirstAchievements(ACHIEVEMENT_RULE_VERSION).find((definition) => definition.id === "tournament-champion/v1")!;
      expect(badge.reward).toEqual({ kind: "badge", amount: 0, packId: null, skuId: null, badgeId: "tournament-champion" });
    });
  });

  describe("evaluateTournamentAchievements", () => {
    it("unlocks first participation and champion but not streak with a single win", () => {
      const result = evaluateTournamentAchievements({
        ruleVersion: ACHIEVEMENT_RULE_VERSION,
        definitionIds: TOURNAMENT_IDS,
        profile: { participated: true, totalWins: 1, consecutiveWins: 1 }
      });
      const byId = new Map(result.evaluations.map((evaluation) => [evaluation.definitionId, evaluation]));
      expect(byId.get("first-tournament/v1")?.unlocked).toBe(true);
      expect(byId.get("tournament-champion/v1")?.unlocked).toBe(true);
      expect(byId.get("win-streak-3/v1")).toMatchObject({ unlocked: false, progress: 1, goal: 3 });
    });

    it("unlocks the three-win streak exactly at the goal boundary", () => {
      const result = evaluateTournamentAchievements({
        ruleVersion: ACHIEVEMENT_RULE_VERSION,
        definitionIds: TOURNAMENT_IDS,
        profile: { participated: true, totalWins: 3, consecutiveWins: 3 }
      });
      expect(result.evaluations.find((evaluation) => evaluation.definitionId === "win-streak-3/v1")?.unlocked).toBe(true);
    });

    it("does not unlock champion or streak when the player lost", () => {
      const result = evaluateTournamentAchievements({
        ruleVersion: ACHIEVEMENT_RULE_VERSION,
        definitionIds: TOURNAMENT_IDS,
        profile: { participated: true, totalWins: 0, consecutiveWins: 0 }
      });
      const byId = new Map(result.evaluations.map((evaluation) => [evaluation.definitionId, evaluation]));
      expect(byId.get("first-tournament/v1")?.unlocked).toBe(true);
      expect(byId.get("tournament-champion/v1")?.unlocked).toBe(false);
      expect(byId.get("win-streak-3/v1")?.unlocked).toBe(false);
    });

    it("caps streak progress at the goal and is deterministic on replay", () => {
      const input = {
        ruleVersion: ACHIEVEMENT_RULE_VERSION,
        definitionIds: TOURNAMENT_IDS,
        profile: { participated: true, totalWins: 10, consecutiveWins: 10 }
      };
      expect(evaluateTournamentAchievements(input)).toEqual(evaluateTournamentAchievements(input));
      const streak = evaluateTournamentAchievements(input).evaluations.find((evaluation) => evaluation.definitionId === "win-streak-3/v1")!;
      expect(streak.progress).toBe(3);
    });

    it("rejects illegal inputs", () => {
      expect(() => evaluateTournamentAchievements({ ruleVersion: "achievement/v2", definitionIds: TOURNAMENT_IDS, profile: { participated: true, totalWins: 0, consecutiveWins: 0 } })).toThrow();
      expect(() => evaluateTournamentAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: ["unknown/v1"], profile: { participated: true, totalWins: 0, consecutiveWins: 0 } })).toThrow("未知的成就定义");
      expect(() => evaluateTournamentAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: TOURNAMENT_IDS, profile: { participated: true, totalWins: -1, consecutiveWins: 0 } })).toThrow();
    });
  });

  describe("evaluateDeckAchievements", () => {
    it("unlocks mono-color commander only when winning with a single color", () => {
      const won = evaluateDeckAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: DECK_IDS, profile: { commanderColors: ["R"], dominantSetCode: "BRO" }, won: true });
      expect(won.evaluations.find((evaluation) => evaluation.definitionId === "mono-color-commander/v1")?.unlocked).toBe(true);
      expect(won.evaluations.find((evaluation) => evaluation.definitionId === "series-pilot/v1")?.unlocked).toBe(true);
      const lost = evaluateDeckAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: DECK_IDS, profile: { commanderColors: ["R"], dominantSetCode: "BRO" }, won: false });
      expect(lost.evaluations.every((evaluation) => !evaluation.unlocked)).toBe(true);
      const multi = evaluateDeckAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: DECK_IDS, profile: { commanderColors: ["W", "U"], dominantSetCode: "BRO" }, won: true });
      expect(multi.evaluations.find((evaluation) => evaluation.definitionId === "mono-color-commander/v1")?.unlocked).toBe(false);
    });

    it("requires a dominant series for the series pilot achievement", () => {
      const noSeries = evaluateDeckAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: DECK_IDS, profile: { commanderColors: ["R"], dominantSetCode: null }, won: true });
      expect(noSeries.evaluations.find((evaluation) => evaluation.definitionId === "series-pilot/v1")?.unlocked).toBe(false);
    });

    it("rejects illegal colors and versions", () => {
      expect(() => evaluateDeckAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: DECK_IDS, profile: { commanderColors: ["X" as never], dominantSetCode: null }, won: true })).toThrow();
      expect(() => evaluateDeckAchievements({ ruleVersion: "bad", definitionIds: DECK_IDS, profile: { commanderColors: ["R"], dominantSetCode: null }, won: true })).toThrow();
    });
  });

  describe("evaluateCollectionAchievements", () => {
    it("unlocks milestones at exact thresholds and keeps higher ones pending", () => {
      const result = evaluateCollectionAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: COLLECTION_IDS, distinctSkuCount: 50 });
      const byId = new Map(result.evaluations.map((evaluation) => [evaluation.definitionId, evaluation]));
      expect(byId.get("collection-10/v1")?.unlocked).toBe(true);
      expect(byId.get("collection-50/v1")?.unlocked).toBe(true);
      expect(byId.get("collection-100/v1")).toMatchObject({ unlocked: false, progress: 50, goal: 100 });
    });

    it("treats zero holdings as no progress and stays deterministic", () => {
      const input = { ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: COLLECTION_IDS, distinctSkuCount: 0 };
      expect(evaluateCollectionAchievements(input)).toEqual(evaluateCollectionAchievements(input));
      expect(evaluateCollectionAchievements(input).evaluations.every((evaluation) => !evaluation.unlocked)).toBe(true);
    });

    it("rejects negative or fractional counts", () => {
      expect(() => evaluateCollectionAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: COLLECTION_IDS, distinctSkuCount: -1 })).toThrow();
      expect(() => evaluateCollectionAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: COLLECTION_IDS, distinctSkuCount: 1.5 })).toThrow();
    });
  });

  describe("evaluateSetCompletionAchievements", () => {
    it("unlocks 80% at 8000bp and 100% only at full collection, goals in bp", () => {
      const partial = evaluateSetCompletionAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: SET_COMPLETION_IDS, profile: { collectedSkuCount: 4, totalSkuCount: 5 } });
      const byId = new Map(partial.evaluations.map((evaluation) => [evaluation.definitionId, evaluation]));
      expect(byId.get("set-completion-80/v1")).toMatchObject({ unlocked: true, progress: 8000, goal: 8000 });
      expect(byId.get("set-completion-100/v1")).toMatchObject({ unlocked: false, progress: 8000, goal: 10000 });
      const full = evaluateSetCompletionAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: SET_COMPLETION_IDS, profile: { collectedSkuCount: 5, totalSkuCount: 5 } });
      expect(full.evaluations.every((evaluation) => evaluation.unlocked)).toBe(true);
    });

    it("treats empty sets as zero progress without division by zero", () => {
      const empty = evaluateSetCompletionAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: SET_COMPLETION_IDS, profile: { collectedSkuCount: 0, totalSkuCount: 0 } });
      expect(empty.evaluations.every((evaluation) => !evaluation.unlocked && evaluation.progress === 0)).toBe(true);
    });

    it("is deterministic on replay and rejects illegal counts or versions", () => {
      const input = { ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: SET_COMPLETION_IDS, profile: { collectedSkuCount: 3, totalSkuCount: 10 } };
      expect(evaluateSetCompletionAchievements(input)).toEqual(evaluateSetCompletionAchievements(input));
      expect(() => evaluateSetCompletionAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: SET_COMPLETION_IDS, profile: { collectedSkuCount: -1, totalSkuCount: 10 } })).toThrow();
      expect(() => evaluateSetCompletionAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds: SET_COMPLETION_IDS, profile: { collectedSkuCount: 11, totalSkuCount: 10 } })).toThrow();
      expect(() => evaluateSetCompletionAchievements({ ruleVersion: "bad", definitionIds: SET_COMPLETION_IDS, profile: { collectedSkuCount: 1, totalSkuCount: 10 } })).toThrow();
    });
  });

  describe("evaluateRewardRisk", () => {
    it("allows rewards within both limits and rejects when either is exceeded", () => {
      const ok = evaluateRewardRisk({ ruleVersion: ACHIEVEMENT_RULE_VERSION, rewardsToday: 2, maxRewardsPerDay: 5, repeatParticipationToday: 1, maxRepeatPerDay: 3 });
      expect(ok).toMatchObject({ allowed: true, reasons: [] });
      const blocked = evaluateRewardRisk({ ruleVersion: ACHIEVEMENT_RULE_VERSION, rewardsToday: 5, maxRewardsPerDay: 5, repeatParticipationToday: 3, maxRepeatPerDay: 3 });
      expect(blocked.allowed).toBe(false);
      expect(blocked.reasons.sort()).toEqual(["daily_reward_limit", "repeat_participation_limit"]);
    });

    it("rejects zero or invalid limits", () => {
      expect(() => evaluateRewardRisk({ ruleVersion: ACHIEVEMENT_RULE_VERSION, rewardsToday: 0, maxRewardsPerDay: 0, repeatParticipationToday: 0, maxRepeatPerDay: 1 })).toThrow();
      expect(() => evaluateRewardRisk({ ruleVersion: ACHIEVEMENT_RULE_VERSION, rewardsToday: 0, maxRewardsPerDay: 1, repeatParticipationToday: 0, maxRepeatPerDay: 0 })).toThrow();
      expect(() => evaluateRewardRisk({ ruleVersion: ACHIEVEMENT_RULE_VERSION, rewardsToday: -1, maxRewardsPerDay: 1, repeatParticipationToday: 0, maxRepeatPerDay: 1 })).toThrow();
    });
  });
});
