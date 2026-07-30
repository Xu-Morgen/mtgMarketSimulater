/**
 * I25B 的赛事规则完全是纯函数。调用方必须持久化输入快照和 seed，不能以当前时间、
 * 数据库状态或浏览器计算来补足任何赛果。
 */
export const TOURNAMENT_RULE_VERSION = "tournament/v1" as const;

export type TournamentKind = "single" | "swiss" | "prereg";
export type TournamentRoundOutcome = "win" | "draw" | "loss" | "bye" | "forfeit";

export interface TournamentNpc {
  id: string;
  name: string;
  powerScore: number;
}

export interface TournamentSimulationInput {
  ruleVersion: string;
  kind: TournamentKind;
  playerScore: number;
  npcs: TournamentNpc[];
  seed: string;
  rewardAmount: number;
  /** 名次 n 与 n+1 的奖励配置不同，且两者同分时必须加赛。默认只区分冠军位。 */
  rewardTieBreakBoundaries?: number[];
}

export interface TournamentSimulationResult {
  ruleVersion: string;
  rounds: Array<{
    round: number;
    npcId: string | null;
    opponentName: string;
    outcome: TournamentRoundOutcome;
    playerScore: number;
    opponentScore: number | null;
    stage: "single" | "swiss" | "elimination" | "playoff";
  }>;
  wins: number;
  draws: number;
  losses: number;
  byes: number;
  forfeits: number;
  points: number;
  rank: number;
  advanced: boolean;
  rewardAmount: number;
  replay: {
    seed: string;
    playerScore: number;
    npcScores: Array<{ id: string; score: number }>;
    swissCut: number;
    standings: Array<{ id: string; points: number; opponentPoints: number }>;
  };
}

export interface GameTournamentPlayer {
  registrationId: string;
  powerScore: number;
}

export interface GameTournamentResult {
  matches: Array<{
    leftRegistrationId: string;
    rightRegistrationId: string;
    outcome: Exclude<TournamentRoundOutcome, "bye" | "forfeit">;
    stage: "standard" | "playoff";
  }>;
  standings: Array<{ registrationId: string; points: number; opponentPoints: number; rank: number }>;
}

interface Competitor {
  id: string;
  name: string;
  powerScore: number;
  points: number;
  opponentIds: string[];
  playedIds: Set<string>;
  seedOrder: number;
}

function assertVersion(ruleVersion: string): void {
  if (ruleVersion !== TOURNAMENT_RULE_VERSION) throw new RangeError("不支持的赛事规则版本");
}

function assertScore(score: number): void {
  if (!Number.isSafeInteger(score) || score < 0 || score > 100) {
    throw new RangeError("评分必须为 0–100 整数");
  }
}

/** 可移植的确定性 PRNG；不是安全随机源，服务端必须先生成并存储 seed。 */
function random(seed: string): () => number {
  let state = 2166136261;
  for (const char of seed) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function seededOrder(seed: string, id: string): number {
  const value = random(`${seed}:${id}`)();
  return Math.floor(value * 0x7fff_ffff);
}

/** 公布的轮数段。1 人 NPC 单场；之后严格采用 I25B 的人数段。 */
export function swissRounds(seats: number): number {
  if (!Number.isSafeInteger(seats) || seats < 1) throw new RangeError("赛事总座位必须至少为 1");
  if (seats === 1) return 1;
  if (seats <= 4) return 2;
  if (seats <= 8) return 3;
  if (seats <= 32) return 5;
  if (seats <= 64) return 6;
  if (seats <= 128) return 7;
  if (seats <= 226) return 8;
  if (seats <= 409) return 9;
  return 10;
}

/** 已发布晋级线，永远不超过参赛人数并保持淘汰签位为 2 的幂。 */
export function swissAdvancementCut(ruleVersion: string, seats: number): number {
  assertVersion(ruleVersion);
  if (!Number.isSafeInteger(seats) || seats < 2) throw new RangeError("淘汰赛至少需要 2 人");
  const configured = seats <= 4 ? 2 : seats <= 8 ? 4 : seats <= 32 ? 8 : seats <= 64 ? 16 : seats <= 128 ? 32 : 64;
  let cut = Math.min(configured, seats);
  while (cut > 2 && (cut & (cut - 1)) !== 0) cut -= 1;
  return cut;
}

/** 差值概率规则：胜率受 5%–95% 限制，固定 4% 和局带宽；输出没有经济金额。 */
export function resolveMatchOutcome(
  ruleVersion: string,
  playerScore: number,
  opponentScore: number,
  draw: number
): Exclude<TournamentRoundOutcome, "bye" | "forfeit"> {
  assertVersion(ruleVersion);
  assertScore(playerScore);
  assertScore(opponentScore);
  if (!(draw >= 0 && draw < 1)) throw new RangeError("随机值无效");
  const winProbability = Math.max(0.05, Math.min(0.95, 0.5 + (playerScore - opponentScore) / 200));
  if (draw < 0.04) return "draw";
  return draw < 0.04 + winProbability * 0.96 ? "win" : "loss";
}

function pointsFor(outcome: TournamentRoundOutcome): number {
  return outcome === "win" ? 4 : outcome === "draw" || outcome === "bye" ? 1 : 0;
}

function inverse(outcome: Exclude<TournamentRoundOutcome, "bye" | "forfeit">): Exclude<TournamentRoundOutcome, "bye" | "forfeit"> {
  return outcome === "win" ? "loss" : outcome === "loss" ? "win" : "draw";
}

function sortStanding(competitors: Competitor[]): Competitor[] {
  const opponentPoints = (competitor: Competitor) => competitor.opponentIds.reduce((sum, id) => sum + (competitors.find((entry) => entry.id === id)?.points ?? 0), 0);
  return [...competitors].sort((left, right) =>
    right.points - left.points || opponentPoints(right) - opponentPoints(left) || left.seedOrder - right.seedOrder || left.id.localeCompare(right.id)
  );
}

function pairSwiss(competitors: Competitor[]): Array<[Competitor, Competitor]> {
  const remaining = [...sortStanding(competitors)];
  const pairs: Array<[Competitor, Competitor]> = [];
  while (remaining.length >= 2) {
    const left = remaining.shift()!;
    let opponentIndex = remaining.findIndex((candidate) => !left.playedIds.has(candidate.id));
    if (opponentIndex < 0) opponentIndex = 0;
    const right = remaining.splice(opponentIndex, 1)[0]!;
    pairs.push([left, right]);
  }
  return pairs;
}

function applyMatch(left: Competitor, right: Competitor, outcome: Exclude<TournamentRoundOutcome, "bye" | "forfeit">): void {
  left.points += pointsFor(outcome);
  right.points += pointsFor(inverse(outcome));
  left.opponentIds.push(right.id);
  right.opponentIds.push(left.id);
  left.playedIds.add(right.id);
  right.playedIds.add(left.id);
}

/**
 * 完整模拟个人 NPC 单场/瑞士/预报名赛事。所有 NPC 也会参加配对和积分，但只有玩家
 * 的名次会被返回为奖励资格；同分先使用对手积分，再以已持久化 seed 的加赛分出奖励位。
 */
export function simulateNpcTournament(input: TournamentSimulationInput): TournamentSimulationResult {
  assertVersion(input.ruleVersion);
  assertScore(input.playerScore);
  if (!input.seed || !Number.isSafeInteger(input.rewardAmount) || input.rewardAmount < 0 || input.npcs.length === 0 || (input.rewardTieBreakBoundaries ?? []).some((boundary) => !Number.isSafeInteger(boundary) || boundary < 1)) {
    throw new RangeError("赛事输入无效");
  }
  if (input.npcs.some((npc) => !npc.id || !npc.name || !Number.isSafeInteger(npc.powerScore))) {
    throw new RangeError("NPC 输入无效");
  }
  input.npcs.forEach((npc) => assertScore(npc.powerScore));

  const rng = random(input.seed);
  const playerId = "player";
  const competitors: Competitor[] = [
    { id: playerId, name: "玩家", powerScore: input.playerScore, points: 0, opponentIds: [], playedIds: new Set(), seedOrder: seededOrder(input.seed, playerId) },
    ...input.npcs
      .map((npc) => ({ ...npc }))
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((npc) => ({ id: npc.id, name: npc.name, powerScore: npc.powerScore, points: 0, opponentIds: [], playedIds: new Set<string>(), seedOrder: seededOrder(input.seed, npc.id) }))
  ];
  const playerRounds: TournamentSimulationResult["rounds"] = [];
  const swissRoundCount = input.kind === "single" ? 1 : swissRounds(competitors.length);

  for (let round = 1; round <= swissRoundCount; round += 1) {
    const ordered = sortStanding(competitors);
    if (ordered.length % 2 === 1) {
      const bye = [...ordered].reverse().find((candidate) => !candidate.opponentIds.includes("__bye__")) ?? ordered[ordered.length - 1]!;
      bye.points += pointsFor("bye");
      bye.opponentIds.push("__bye__");
      if (bye.id === playerId) {
        playerRounds.push({ round, npcId: null, opponentName: "轮空", outcome: "bye", playerScore: input.playerScore, opponentScore: null, stage: input.kind === "single" ? "single" : "swiss" });
      }
      const index = competitors.indexOf(bye);
      competitors.splice(index, 1);
      const pairs = pairSwiss(competitors);
      competitors.splice(index, 0, bye);
      for (const [left, right] of pairs) {
        const outcome = resolveMatchOutcome(input.ruleVersion, left.powerScore, right.powerScore, rng());
        applyMatch(left, right, outcome);
        if (left.id === playerId || right.id === playerId) {
          const player = left.id === playerId ? left : right;
          const npc = player === left ? right : left;
          playerRounds.push({ round, npcId: npc.id, opponentName: npc.name, outcome: player === left ? outcome : inverse(outcome), playerScore: player.powerScore, opponentScore: npc.powerScore, stage: input.kind === "single" ? "single" : "swiss" });
        }
      }
    } else {
      for (const [left, right] of pairSwiss(competitors)) {
        const outcome = resolveMatchOutcome(input.ruleVersion, left.powerScore, right.powerScore, rng());
        applyMatch(left, right, outcome);
        if (left.id === playerId || right.id === playerId) {
          const player = left.id === playerId ? left : right;
          const npc = player === left ? right : left;
          playerRounds.push({ round, npcId: npc.id, opponentName: npc.name, outcome: player === left ? outcome : inverse(outcome), playerScore: player.powerScore, opponentScore: npc.powerScore, stage: input.kind === "single" ? "single" : "swiss" });
        }
      }
    }
  }

  let standing = sortStanding(competitors);
  const player = competitors.find((candidate) => candidate.id === playerId)!;
  let playerRank = standing.findIndex((candidate) => candidate.id === playerId) + 1;
  const cut = input.kind === "single" ? 1 : swissAdvancementCut(input.ruleVersion, competitors.length);
  let advanced = input.kind === "single" ? true : playerRank <= cut;

  const opponentPoints = (candidate: Competitor) => candidate.opponentIds.reduce((sum, id) => sum + (competitors.find((entry) => entry.id === id)?.points ?? 0), 0);
  let tieStart = standing.findIndex((candidate) => candidate.id === playerId);
  let tieEnd = tieStart + 1;
  while (tieStart > 0 && standing[tieStart - 1]!.points === player.points && opponentPoints(standing[tieStart - 1]!) === opponentPoints(player)) tieStart -= 1;
  while (tieEnd < standing.length && standing[tieEnd]!.points === player.points && opponentPoints(standing[tieEnd]!) === opponentPoints(player)) tieEnd += 1;
  const rewardBoundaries = input.rewardTieBreakBoundaries ?? [1];
  const crossesRewardBoundary = rewardBoundaries.some((boundary) => boundary >= tieStart + 1 && boundary < tieEnd);
  if (crossesRewardBoundary && tieEnd - tieStart > 1) {
    const tied = standing.slice(tieStart, tieEnd);
    const playoffPoints = new Map(tied.map((candidate) => [candidate.id, 0]));
    for (let leftIndex = 0; leftIndex < tied.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < tied.length; rightIndex += 1) {
        const left = tied[leftIndex]!;
        const right = tied[rightIndex]!;
        // 加赛不可保留和局：反复赛至决出奖励位在离线重放中等价为跳过和局带宽。
        const outcome = resolveMatchOutcome(input.ruleVersion, left.powerScore, right.powerScore, 0.04 + rng() * 0.96);
        playoffPoints.set(left.id, playoffPoints.get(left.id)! + pointsFor(outcome));
        playoffPoints.set(right.id, playoffPoints.get(right.id)! + pointsFor(inverse(outcome)));
        if (left.id === playerId || right.id === playerId) {
          const opponent = left.id === playerId ? right : left;
          playerRounds.push({ round: playerRounds.length + 1, npcId: opponent.id, opponentName: opponent.name, outcome: left.id === playerId ? outcome : inverse(outcome), playerScore: player.powerScore, opponentScore: opponent.powerScore, stage: "playoff" });
        }
      }
    }
    const resolvedTie = [...tied].sort((left, right) => playoffPoints.get(right.id)! - playoffPoints.get(left.id)! || left.seedOrder - right.seedOrder || left.id.localeCompare(right.id));
    standing = [...standing.slice(0, tieStart), ...resolvedTie, ...standing.slice(tieEnd)];
  }
  playerRank = standing.findIndex((candidate) => candidate.id === playerId) + 1;
  advanced = input.kind === "single" ? true : playerRank <= cut;

  if (input.kind !== "single" && advanced) {
    const bracket = standing.slice(0, cut);
    let active = bracket;
    let eliminationRound = 0;
    while (active.length > 1) {
      const winners: Competitor[] = [];
      for (let index = 0; index < active.length / 2; index += 1) {
        const left = active[index]!;
        const right = active[active.length - 1 - index]!;
        const outcome = resolveMatchOutcome(input.ruleVersion, left.powerScore, right.powerScore, rng());
        const winner = outcome === "win" || outcome === "draw" && left.seedOrder <= right.seedOrder ? left : right;
        const loser = winner === left ? right : left;
        winners.push(winner);
        if (left.id === playerId || right.id === playerId) {
          const opponent = left.id === playerId ? right : left;
          const playerOutcome = left.id === playerId ? outcome : inverse(outcome);
          playerRounds.push({ round: swissRoundCount + ++eliminationRound, npcId: opponent.id, opponentName: opponent.name, outcome: playerOutcome, playerScore: player.powerScore, opponentScore: opponent.powerScore, stage: "elimination" });
          if (loser.id === playerId) playerRank = Math.max(playerRank, winners.length + 1);
        }
      }
      active = winners;
    }
    if (active[0]!.id === playerId) playerRank = 1;
  }

  const wins = playerRounds.filter((round) => round.outcome === "win").length;
  const draws = playerRounds.filter((round) => round.outcome === "draw").length;
  const losses = playerRounds.filter((round) => round.outcome === "loss").length;
  const byes = playerRounds.filter((round) => round.outcome === "bye").length;
  const forfeits = playerRounds.filter((round) => round.outcome === "forfeit").length;
  const points = playerRounds.filter((round) => round.stage === "swiss" || round.stage === "single").reduce((sum, round) => sum + pointsFor(round.outcome), 0);

  return {
    ruleVersion: input.ruleVersion,
    rounds: playerRounds,
    wins,
    draws,
    losses,
    byes,
    forfeits,
    points,
    rank: playerRank,
    advanced,
    rewardAmount: playerRank === 1 ? input.rewardAmount : 0,
    replay: {
      seed: input.seed,
      playerScore: input.playerScore,
      npcScores: input.npcs.map((npc) => ({ id: npc.id, score: npc.powerScore })),
      swissCut: cut,
      standings: standing.map((competitor) => ({ id: competitor.id, points: competitor.points, opponentPoints: competitor.opponentIds.reduce((sum, id) => sum + (competitors.find((entry) => entry.id === id)?.points ?? 0), 0) }))
    }
  };
}

/** 游戏内多人赛事使用同一差值规则，所有配对与排名均可由 seed、快照分数重放。 */
export function resolveGameTournament(
  ruleVersion: string,
  players: GameTournamentPlayer[],
  seed: string,
  rewardTieBreakBoundaries: number[] = []
): GameTournamentResult {
  assertVersion(ruleVersion);
  if (!seed || players.length < 1 || new Set(players.map((player) => player.registrationId)).size !== players.length || rewardTieBreakBoundaries.some((boundary) => !Number.isSafeInteger(boundary) || boundary < 1)) throw new RangeError("游戏内赛事输入无效");
  players.forEach((player) => { if (!player.registrationId) throw new RangeError("报名标识无效"); assertScore(player.powerScore); });
  const rng = random(seed);
  const points = new Map(players.map((player) => [player.registrationId, 0]));
  const opponents = new Map(players.map((player) => [player.registrationId, [] as string[]]));
  const matches: GameTournamentResult["matches"] = [];
  const ordered = [...players].sort((left, right) => left.registrationId.localeCompare(right.registrationId));
  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const left = ordered[leftIndex]!;
      const right = ordered[rightIndex]!;
      const outcome = resolveMatchOutcome(ruleVersion, left.powerScore, right.powerScore, rng());
      points.set(left.registrationId, points.get(left.registrationId)! + pointsFor(outcome));
      points.set(right.registrationId, points.get(right.registrationId)! + pointsFor(inverse(outcome)));
      opponents.get(left.registrationId)!.push(right.registrationId);
      opponents.get(right.registrationId)!.push(left.registrationId);
      matches.push({ leftRegistrationId: left.registrationId, rightRegistrationId: right.registrationId, outcome, stage: "standard" });
    }
  }
  const base = ordered
    .map((player) => ({ registrationId: player.registrationId, points: points.get(player.registrationId)!, opponentPoints: opponents.get(player.registrationId)!.reduce((sum, opponentId) => sum + (points.get(opponentId) ?? 0), 0) }))
    .sort((left, right) => right.points - left.points || right.opponentPoints - left.opponentPoints || seededOrder(seed, left.registrationId) - seededOrder(seed, right.registrationId) || left.registrationId.localeCompare(right.registrationId));
  const powerScores = new Map(players.map((player) => [player.registrationId, player.powerScore]));
  const orderedForRanks: typeof base = [];
  for (let start = 0; start < base.length;) {
    let end = start + 1;
    while (end < base.length && base[end]!.points === base[start]!.points && base[end]!.opponentPoints === base[start]!.opponentPoints) end += 1;
    const group = base.slice(start, end);
    const crossesRewardBoundary = rewardTieBreakBoundaries.some((boundary) => boundary >= start + 1 && boundary < end);
    if (!crossesRewardBoundary || group.length === 1) {
      orderedForRanks.push(...group);
    } else {
      const playoffPoints = new Map(group.map((entry) => [entry.registrationId, 0]));
      const playoffSeed = `${seed}:reward-playoff:${start + 1}`;
      for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
          const left = group[leftIndex]!;
          const right = group[rightIndex]!;
          // 加赛必须决出名次：跳过和局带宽，但仍复用同一版本化差值概率规则。
          const outcome = resolveMatchOutcome(ruleVersion, powerScores.get(left.registrationId)!, powerScores.get(right.registrationId)!, 0.04 + random(`${playoffSeed}:${left.registrationId}:${right.registrationId}`)() * 0.96);
          playoffPoints.set(left.registrationId, playoffPoints.get(left.registrationId)! + pointsFor(outcome));
          playoffPoints.set(right.registrationId, playoffPoints.get(right.registrationId)! + pointsFor(inverse(outcome)));
          matches.push({ leftRegistrationId: left.registrationId, rightRegistrationId: right.registrationId, outcome, stage: "playoff" });
        }
      }
      orderedForRanks.push(...group.sort((left, right) => playoffPoints.get(right.registrationId)! - playoffPoints.get(left.registrationId)! || seededOrder(playoffSeed, left.registrationId) - seededOrder(playoffSeed, right.registrationId) || left.registrationId.localeCompare(right.registrationId)));
    }
    start = end;
  }
  const standings = orderedForRanks.map((standing, index) => ({ ...standing, rank: index + 1 }));
  return { matches, standings };
}

export interface TabletopRegistrant {
  registrationId: string;
  points: number;
}

/** 现实桌配对：在可行时所有桌恰为 4–8 人；人数较少时保留单桌，绝不强行拒绝创建赛事。 */
export function pairTabletopSwiss(ruleVersion: string, registrants: TabletopRegistrant[], seed: string): string[][] {
  assertVersion(ruleVersion);
  if (!seed || registrants.some((entry) => !entry.registrationId || !Number.isSafeInteger(entry.points) || entry.points < 0) || new Set(registrants.map((entry) => entry.registrationId)).size !== registrants.length) throw new RangeError("现实桌配对输入无效");
  if (registrants.length === 0) return [];
  const ordered = [...registrants].sort((left, right) => right.points - left.points || seededOrder(seed, left.registrationId) - seededOrder(seed, right.registrationId) || left.registrationId.localeCompare(right.registrationId));
  const tableCount = Math.max(1, Math.ceil(ordered.length / 8));
  const base = Math.floor(ordered.length / tableCount);
  const remainder = ordered.length % tableCount;
  const tables: string[][] = [];
  let cursor = 0;
  for (let table = 0; table < tableCount; table += 1) {
    const size = base + (table < remainder ? 1 : 0);
    tables.push(ordered.slice(cursor, cursor + size).map((entry) => entry.registrationId));
    cursor += size;
  }
  return tables;
}

/** 现实桌确认后固定积分：胜 4、平局全员 1、弃权/退出 0。 */
export function tabletopPoints(
  ruleVersion: string,
  input: { registrationId: string; winner: boolean; draw: boolean; forfeited: boolean }[]
): Array<{ registrationId: string; points: number }> {
  assertVersion(ruleVersion);
  if (input.length < 1 || input.some((entry) => !entry.registrationId) || new Set(input.map((entry) => entry.registrationId)).size !== input.length) throw new RangeError("现实桌赛果无效");
  const winnerCount = input.filter((entry) => entry.winner).length;
  const hasDraw = input.some((entry) => entry.draw);
  if (winnerCount > 1 || (hasDraw && winnerCount > 0) || (hasDraw && input.some((entry) => !entry.draw))) throw new RangeError("现实桌胜者或平局不一致");
  if (!hasDraw && winnerCount === 0 && input.some((entry) => !entry.forfeited)) throw new RangeError("现实桌弃权赛果必须指定胜者");
  return input.map((entry) => ({ registrationId: entry.registrationId, points: entry.forfeited ? 0 : entry.draw ? 1 : entry.winner ? 4 : 0 }));
}

/** 随机奖励池抽签：候选池由调用方连同 seed、版本和命中项一并持久化。 */
export function drawRewardPool(ruleVersion: string, seed: string, candidates: Array<{ id: string; weight: number }>): string {
  assertVersion(ruleVersion);
  if (!seed || candidates.length === 0 || candidates.some((entry) => !entry.id || !Number.isSafeInteger(entry.weight) || entry.weight <= 0)) throw new RangeError("奖励池输入无效");
  const total = candidates.reduce((sum, entry) => sum + entry.weight, 0);
  if (!Number.isSafeInteger(total) || total <= 0) throw new RangeError("奖励池权重无效");
  let cursor = Math.floor(random(seed)() * total);
  for (const candidate of candidates) {
    if (cursor < candidate.weight) return candidate.id;
    cursor -= candidate.weight;
  }
  return candidates[candidates.length - 1]!.id;
}
