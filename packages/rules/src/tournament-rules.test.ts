import { describe, expect, it } from "vitest";
import { drawRewardPool, pairTabletopSwiss, resolveGameTournament, resolveMatchOutcome, simulateNpcTournament, swissAdvancementCut, swissRounds, tabletopPoints, TOURNAMENT_RULE_VERSION } from "./tournament-rules.js";

describe("tournament/v1", () => {
  it("uses the published Swiss round bands", () => {
    expect([swissRounds(1), swissRounds(2), swissRounds(4), swissRounds(5), swissRounds(8), swissRounds(9), swissRounds(32), swissRounds(33), swissRounds(64), swissRounds(65), swissRounds(128), swissRounds(129), swissRounds(226), swissRounds(227), swissRounds(409), swissRounds(410)]).toEqual([1, 2, 2, 3, 3, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10]);
  });
  it("uses versioned Swiss advancement lines", () => {
    expect([swissAdvancementCut(TOURNAMENT_RULE_VERSION, 4), swissAdvancementCut(TOURNAMENT_RULE_VERSION, 8), swissAdvancementCut(TOURNAMENT_RULE_VERSION, 32), swissAdvancementCut(TOURNAMENT_RULE_VERSION, 128)]).toEqual([2, 4, 8, 32]);
  });
  it("is deterministic and keeps points in the 4/1/0 system", () => {
    const input = { ruleVersion: TOURNAMENT_RULE_VERSION, kind: "swiss" as const, playerScore: 70, npcs: [{ id: "a", name: "甲", powerScore: 40 }, { id: "b", name: "乙", powerScore: 50 }, { id: "c", name: "丙", powerScore: 55 }], seed: "seed", rewardAmount: 500 };
    const first = simulateNpcTournament(input); expect(simulateNpcTournament(input)).toEqual(first); expect(first.points).toBe(first.rounds.filter((round) => round.stage === "swiss").reduce((sum, round) => sum + (round.outcome === "win" ? 4 : round.outcome === "draw" || round.outcome === "bye" ? 1 : 0), 0)); expect(first.rounds.length).toBeGreaterThanOrEqual(2);
  });
  it("bounds probability and rejects unsupported versions", () => {
    expect(resolveMatchOutcome(TOURNAMENT_RULE_VERSION, 100, 0, .1)).toBe("win");
    expect(() => resolveMatchOutcome("wrong", 50, 50, .5)).toThrow();
    expect(() => swissRounds(0)).toThrow();
  });
  it("pairs real tables deterministically and applies fixed table points", () => {
    expect(pairTabletopSwiss(TOURNAMENT_RULE_VERSION, Array.from({ length: 9 }, (_, index) => ({ registrationId: String(index), points: index % 2 })), "pair-seed").map((table) => table.length)).toEqual([5, 4]);
    expect(tabletopPoints(TOURNAMENT_RULE_VERSION, [{ registrationId: "a", winner: true, draw: false, forfeited: false }, { registrationId: "b", winner: false, draw: false, forfeited: false }, { registrationId: "c", winner: false, draw: false, forfeited: true }])).toEqual([{ registrationId: "a", points: 4 }, { registrationId: "b", points: 0 }, { registrationId: "c", points: 0 }]);
  });
  it("draws a replayable reward-pool candidate", () => {
    expect(drawRewardPool(TOURNAMENT_RULE_VERSION, "reward-seed", [{ id: "credit", weight: 1 }, { id: "pack", weight: 2 }])).toBe(drawRewardPool(TOURNAMENT_RULE_VERSION, "reward-seed", [{ id: "credit", weight: 1 }, { id: "pack", weight: 2 }]));
  });
  it("ranks an in-game event from only snapshots and its stored seed", () => {
    const input = [{ registrationId: "a", powerScore: 61 }, { registrationId: "b", powerScore: 50 }, { registrationId: "c", powerScore: 44 }];
    expect(resolveGameTournament(TOURNAMENT_RULE_VERSION, input, "game-seed")).toEqual(resolveGameTournament(TOURNAMENT_RULE_VERSION, input, "game-seed"));
    expect(resolveGameTournament(TOURNAMENT_RULE_VERSION, input, "game-seed").standings.map((row) => row.rank)).toEqual([1, 2, 3]);
  });
  it("replays a decisive game playoff only when a reward boundary is tied", () => {
    const players = [{ registrationId: "a", powerScore: 50 }, { registrationId: "b", powerScore: 50 }];
    const seed = Array.from({ length: 100 }, (_, index) => `tie-seed-${index}`).find((candidate) => {
      const standings = resolveGameTournament(TOURNAMENT_RULE_VERSION, players, candidate).standings;
      return standings[0]!.points === standings[1]!.points && standings[0]!.opponentPoints === standings[1]!.opponentPoints;
    });
    expect(seed).toBeDefined();
    const result = resolveGameTournament(TOURNAMENT_RULE_VERSION, players, seed!, [1]);
    expect(result.matches.filter((match) => match.stage === "playoff")).toHaveLength(1);
    expect(result.matches.filter((match) => match.stage === "playoff")[0]!.outcome).not.toBe("draw");
    expect(resolveGameTournament(TOURNAMENT_RULE_VERSION, [{ registrationId: "solo", powerScore: 50 }], "solo-seed").standings).toEqual([{ registrationId: "solo", points: 0, opponentPoints: 0, rank: 1 }]);
  });
  it("rejects an ambiguous tabletop forfeit without a winner", () => {
    expect(() => tabletopPoints(TOURNAMENT_RULE_VERSION, [{ registrationId: "a", winner: false, draw: false, forfeited: true }, { registrationId: "b", winner: false, draw: false, forfeited: false }])).toThrow();
  });
});
