import { createHash, randomBytes, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalizeRequest,
  type ApiErrorCode,
  type ApiResponse,
  type DeckDto,
  type PackOpeningDto,
  type PlayerTournamentDto,
  type PlayerTournamentRegistrationDto,
  type PlayerTournamentRoundDto,
  type PlayerTournamentResultDto,
  type TournamentDto,
  type TournamentHistoryItemDto,
  type TournamentRegistrationDto,
  type TournamentRewardDetailDto,
  type TournamentSettlementDto
} from "@mtg-market/contracts";
import {
  drawRewardPool,
  pairTabletopSwiss,
  resolveGameTournament,
  simulateNpcTournament,
  tabletopPoints,
  TOURNAMENT_RULE_VERSION,
  type TournamentKind
} from "@mtg-market/rules";
import { DeckService } from "../../decks/application/deck-service.js";
import { LeylineEvaluationError, type LeylineClient } from "../../decks/infrastructure/leyline-client.js";
import { InventoryService } from "../../inventory/application/inventory-service.js";
import { enqueueAchievementProcessJob, enqueueTournamentSettleJob } from "../../jobs/application/task-service.js";
import { PackService } from "../../packs/application/pack-service.js";
import { UserService } from "../../users/application/user-service.js";
import { naturalDateAt } from "../../users/domain/natural-day.js";
import { failure, success } from "../../../shared/http/api-response.js";

type Template = {
  id: string;
  version: string;
  kind: TournamentKind;
  total_seats: number;
  entry_fee_amount: number;
  difficulty: number;
  reward_amount: number;
  entry_condition: "valid_commander_deck";
  daily_registration_limit: number;
  start_mode: "on_registration" | "at_cutoff";
  opens_at: string;
  cutoff_at: string | null;
};

type Tournament = {
  id: string;
  template_id: string;
  natural_date: string;
  owner_user_id: string;
  timezone: string;
  status: "open" | "settling" | "settled" | "cancelled";
  rule_version: string;
  seed: string;
  seed_hash: string;
  opens_at: string;
  cutoff_at: string | null;
  created_at: string;
  settled_at: string | null;
};

type Registration = {
  id: string;
  tournament_id: string;
  user_id: string;
  deck_id: string;
  power_snapshot_id: string;
  status: "registered" | "settled" | "eliminated";
  entry_fee_amount: number;
  registered_at: string;
  settled_at: string | null;
};

type PowerSnapshot = {
  id: string;
  source: "leyline" | "local" | "ml";
  source_version: string;
  provider_algorithm_version: string | null;
  score: number;
  input_summary_sha256: string;
  computed_at: string;
  availability: "available" | "degraded";
  degradation_reason: null;
  response_sha256: string | null;
};

type Idempotency = {
  request_fingerprint: string;
  status: string;
  response_status: number | null;
  response_json: string | null;
};

type ResultRow = {
  tournament_id: string;
  registration_id: string;
  rank: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  outcome_json: string;
  replay_json: string;
  reward_amount: number;
  settled_at: string;
};

type PlayerTournamentRow = {
  id: string;
  creator_user_id: string;
  mode: "game" | "tabletop";
  name: string;
  status: "open" | "in_progress" | "settled" | "disputed" | "cancelled";
  rule_version: string;
  random_seed: string;
  seed_hash: string;
  created_at: string;
  settled_at: string | null;
  reward_profile_id: string | null;
};

type PlayerRewardProfile = {
  id: string;
  version: string;
  mode: "game" | "tabletop";
  tie_policy: "playoff_at_reward_boundary";
};

type PlayerRewardEntry = {
  id: string;
  reward_kind: "GAME_CREDIT" | "pack" | "sku";
  amount: number;
  pack_id: string | null;
  sku_id: string | null;
  weight: number;
  min_rank: number;
  max_rank: number;
  rule_version: string;
};

type PlayerRegistrationRow = {
  id: string;
  tournament_id: string;
  user_id: string;
  deck_name: string;
  deck_id: string | null;
  power_snapshot_id: string | null;
  status: "registered" | "withdrawn" | "eliminated";
  points: number;
  created_at: string;
};

type CommandState<T> =
  | { state: "completed" | "replayed"; data: T }
  | { state: "conflict" | "in-progress" };

type RegistrationCommand = { statusCode: number; response: ApiResponse<{ registration: TournamentRegistrationDto }> };
type PackClaimCommand = { statusCode: number; response: ApiResponse<{ opening: PackOpeningDto }> };
type Award = { amount: number; detail: TournamentRewardDetailDto };
export type TournamentLogger = { warn: (bindings: Record<string, unknown>, message: string) => void };
const silentTournamentLogger: TournamentLogger = { warn: () => undefined };

/**
 * I25B 赛事应用入口。所有写路径均由 application 持有短事务、幂等键和审计；路由层
 * 不读取表、不重算赛果，deck/inventory/users 只经各自 application 原语协作。
 */
export class TournamentService {
  private readonly inventory: InventoryService;
  private readonly users: UserService;
  private readonly decks: DeckService;
  private readonly packs: PackService;

  constructor(
    private readonly database: Database.Database,
    private readonly config: { timezone: string; encryptionKey: string; leyline: LeylineClient; logger?: TournamentLogger }
  ) {
    this.inventory = new InventoryService(database);
    this.users = new UserService(database);
    this.decks = new DeckService(database);
    this.packs = new PackService(database);
  }

  /** 同一 actor+key 只持久化一次命令结果，供无外部 I/O 的玩家赛事写命令使用。 */
  executePlayerCommand<T>(input: {
    actorId: string;
    idempotencyKey: string;
    body: unknown;
    now?: Date;
    operation: () => T;
  }): CommandState<T> {
    const now = (input.now ?? new Date()).toISOString();
    const fingerprint = this.fingerprint(input.body);
    return this.database.transaction(() => {
      const prior = this.idempotency(input.actorId, input.idempotencyKey);
      if (prior) return this.commandReplay<T>(prior, fingerprint);
      try {
        this.insertRunningIdempotency(input.actorId, input.idempotencyKey, fingerprint, now);
      } catch {
        const raced = this.idempotency(input.actorId, input.idempotencyKey);
        return raced ? this.commandReplay<T>(raced, fingerprint) : { state: "in-progress" };
      }
      const data = input.operation();
      this.completeCommand(input.actorId, input.idempotencyKey, data, now);
      return { state: "completed", data };
    })() as CommandState<T>;
  }

  /** 日切/停机补跑入口：唯一键保留已经报名或结算的实例，绝不重置。 */
  refreshDaily(naturalDate: string, timezone: string, now = new Date()): void {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(naturalDate) || !timezone.trim()) throw new RangeError("赛事日切输入无效");
    this.database.transaction(() => {
      const users = this.database.prepare("SELECT id FROM users").all() as Array<{ id: string }>;
      for (const user of users) this.ensureDailyForUser(user.id, naturalDate, timezone, now.toISOString());
    })();
  }

  list(userId: string, now = new Date()): TournamentDto[] {
    const naturalDate = naturalDateAt(now, this.config.timezone);
    this.database.transaction(() => this.ensureDailyForUser(userId, naturalDate, this.config.timezone, now.toISOString()))();
    return (this.database
      .prepare("SELECT * FROM tournaments WHERE owner_user_id = ? AND natural_date = ? ORDER BY template_id")
      .all(userId, naturalDate) as Tournament[]).map((tournament) => this.tournamentDto(tournament, userId));
  }

  /** 历史只读取当前玩家自己的报名和已结算服务端结果，绝不由浏览器拼接。 */
  history(userId: string): TournamentHistoryItemDto[] {
    const rows = this.database.prepare(
      `SELECT tournament.* FROM tournaments tournament
       JOIN tournament_registrations registration ON registration.tournament_id = tournament.id
       WHERE registration.user_id = ?
       ORDER BY tournament.natural_date DESC, tournament.created_at DESC`
    ).all(userId) as Tournament[];
    return rows.map((tournament) => ({
      tournament: this.tournamentDto(tournament, userId),
      registration: this.registration(userId, tournament.id)!,
      result: this.settlement(userId, tournament.id)
    }));
  }

  registration(userId: string, tournamentId: string): TournamentRegistrationDto | null {
    const registration = this.database
      .prepare("SELECT * FROM tournament_registrations WHERE tournament_id = ? AND user_id = ?")
      .get(tournamentId, userId) as Registration | undefined;
    return registration ? this.registrationDto(registration) : null;
  }

  settlement(userId: string, tournamentId: string): TournamentSettlementDto | null {
    const result = this.database
      .prepare(
        `SELECT result.* FROM tournament_results result
         JOIN tournament_registrations registration ON registration.id = result.registration_id
         WHERE result.tournament_id = ? AND registration.user_id = ?`
      )
      .get(tournamentId, userId) as ResultRow | undefined;
    return result ? this.settlementDto(result) : null;
  }

  availablePackGrants(userId: string): Array<{ id: string; tournamentId: string; packId: string; status: "available" | "claimed"; createdAt: string; claimedAt: string | null }> {
    return this.database.prepare(
      `SELECT grant.id, registration.tournament_id, grant.pack_id, grant.status, grant.created_at, grant.claimed_at
       FROM tournament_pack_grants grant
       JOIN tournament_registrations registration ON registration.id = grant.registration_id
       WHERE registration.user_id = ? ORDER BY grant.created_at DESC, grant.id DESC`
    ).all(userId).map((row) => {
      const value = row as { id: string; tournament_id: string; pack_id: string; status: "available" | "claimed"; created_at: string; claimed_at: string | null };
      return { id: value.id, tournamentId: value.tournament_id, packId: value.pack_id, status: value.status, createdAt: value.created_at, claimedAt: value.claimed_at };
    });
  }

  availablePlayerTournamentPackGrants(userId: string): Array<{ id: string; tournamentId: string; packId: string; status: "available" | "claimed"; createdAt: string; claimedAt: string | null }> {
    return this.database.prepare(
      `SELECT grant.id, registration.tournament_id, grant.pack_id, grant.status, grant.created_at, grant.claimed_at
       FROM player_tournament_pack_grants grant
       JOIN player_tournament_registrations registration ON registration.id = grant.registration_id
       WHERE registration.user_id = ? ORDER BY grant.created_at DESC, grant.id DESC`
    ).all(userId).map((row) => {
      const value = row as { id: string; tournament_id: string; pack_id: string; status: "available" | "claimed"; created_at: string; claimed_at: string | null };
      return { id: value.id, tournamentId: value.tournament_id, packId: value.pack_id, status: value.status, createdAt: value.created_at, claimedAt: value.claimed_at };
    });
  }

  /** 奖励 pack 凭证只可由所属玩家以幂等键领取一次；开包、入库、事实和凭证消费同事务。 */
  claimTournamentPack(input: { userId: string; grantId: string; idempotencyKey: string; requestId: string; now?: Date }): PackClaimCommand {
    const now = (input.now ?? new Date()).toISOString();
    const fingerprint = this.fingerprint({ operation: "tournament-pack-claim", grantId: input.grantId });
    return this.inventory.withLedgerTransaction(() => {
      const prior = this.idempotency(input.userId, input.idempotencyKey);
      if (prior) return this.packClaimReplay(prior, fingerprint, input.requestId);
      try {
        this.insertRunningIdempotency(input.userId, input.idempotencyKey, fingerprint, now);
      } catch {
        const raced = this.idempotency(input.userId, input.idempotencyKey);
        return raced ? this.packClaimReplay(raced, fingerprint, input.requestId) : this.packClaimReply(409, input.requestId, "IDEMPOTENCY_IN_PROGRESS", "请求正在处理");
      }
      const grant = this.database.prepare(
        `SELECT grant.id, grant.pack_id, grant.status FROM tournament_pack_grants grant
         JOIN tournament_registrations registration ON registration.id = grant.registration_id
         WHERE grant.id = ? AND registration.user_id = ?`
      ).get(input.grantId, input.userId) as { id: string; pack_id: string; status: "available" | "claimed" } | undefined;
      if (!grant) return this.completePackClaim(input.userId, input.idempotencyKey, now, this.packClaimReply(404, input.requestId, "RESOURCE_NOT_FOUND", "奖励补充包不存在"));
      if (grant.status !== "available") return this.completePackClaim(input.userId, input.idempotencyKey, now, this.packClaimReply(409, input.requestId, "RESOURCE_CONFLICT", "奖励补充包已领取"));
      const opening = this.packs.openTournamentGrantInLedgerTransaction({ userId: input.userId, packId: grant.pack_id, grantId: grant.id, requestId: input.requestId, now });
      const consumed = this.database.prepare("UPDATE tournament_pack_grants SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'available'").run(now, grant.id);
      if (consumed.changes !== 1) throw new Error("奖励补充包凭证状态损坏");
      this.users.writeEconomicAudit(input.userId, "tournament_reward.pack_claimed", "tournament_pack_grant", grant.id, input.requestId, { packId: grant.pack_id, openingId: opening.id }, now);
      return this.completePackClaim(input.userId, input.idempotencyKey, now, { statusCode: 201, response: success(input.requestId, { opening }) });
    });
  }

  /** 玩家赛事奖励与 NPC 奖励一样只能由获奖者以幂等键领取；二者使用隔离的外键表。 */
  claimPlayerTournamentPack(input: { userId: string; grantId: string; idempotencyKey: string; requestId: string; now?: Date }): PackClaimCommand {
    const now = (input.now ?? new Date()).toISOString();
    const fingerprint = this.fingerprint({ operation: "player-tournament-pack-claim", grantId: input.grantId });
    return this.inventory.withLedgerTransaction(() => {
      const prior = this.idempotency(input.userId, input.idempotencyKey);
      if (prior) return this.packClaimReplay(prior, fingerprint, input.requestId);
      try {
        this.insertRunningIdempotency(input.userId, input.idempotencyKey, fingerprint, now);
      } catch {
        const raced = this.idempotency(input.userId, input.idempotencyKey);
        return raced ? this.packClaimReplay(raced, fingerprint, input.requestId) : this.packClaimReply(409, input.requestId, "IDEMPOTENCY_IN_PROGRESS", "请求正在处理");
      }
      const grant = this.database.prepare(
        `SELECT grant.id, grant.pack_id, grant.status FROM player_tournament_pack_grants grant
         JOIN player_tournament_registrations registration ON registration.id = grant.registration_id
         WHERE grant.id = ? AND registration.user_id = ?`
      ).get(input.grantId, input.userId) as { id: string; pack_id: string; status: "available" | "claimed" } | undefined;
      if (!grant) return this.completePackClaim(input.userId, input.idempotencyKey, now, this.packClaimReply(404, input.requestId, "RESOURCE_NOT_FOUND", "玩家赛事奖励补充包不存在"));
      if (grant.status !== "available") return this.completePackClaim(input.userId, input.idempotencyKey, now, this.packClaimReply(409, input.requestId, "RESOURCE_CONFLICT", "玩家赛事奖励补充包已领取"));
      const opening = this.packs.openTournamentGrantInLedgerTransaction({ userId: input.userId, packId: grant.pack_id, grantId: grant.id, requestId: input.requestId, now });
      const consumed = this.database.prepare("UPDATE player_tournament_pack_grants SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'available'").run(now, grant.id);
      if (consumed.changes !== 1) throw new Error("玩家赛事奖励补充包凭证状态损坏");
      this.users.writeEconomicAudit(input.userId, "player_tournament_reward.pack_claimed", "player_tournament_pack_grant", grant.id, input.requestId, { packId: grant.pack_id, openingId: opening.id }, now);
      return this.completePackClaim(input.userId, input.idempotencyKey, now, { statusCode: 201, response: success(input.requestId, { opening }) });
    });
  }

  /** 玩家创建赛事属于无奖励的受控默认配置；完整后台奖池编辑保留给 I30B。 */
  createPlayerTournament(input: {
    creatorUserId: string;
    mode: "game" | "tabletop";
    name: string;
    requestId: string;
    now?: Date;
  }): string {
    const now = (input.now ?? new Date()).toISOString();
    const id = randomUUID();
    const seed = randomBytes(32).toString("hex");
    const rewardProfileId = input.mode === "game" ? "player-game-standard/v1" : "player-tabletop-standard/v1";
    if (!this.database.prepare("SELECT 1 FROM player_tournament_reward_profiles WHERE id = ? AND mode = ?").get(rewardProfileId, input.mode)) throw new Error("玩家赛事奖励配置缺失");
    this.database
      .prepare(
        `INSERT INTO player_tournaments
         (id, creator_user_id, mode, format, name, status, rule_version, random_seed, seed_hash, created_at, settled_at, reward_profile_id)
         VALUES (?, ?, ?, 'commander', ?, 'open', ?, ?, ?, ?, NULL, ?)`
      )
      .run(id, input.creatorUserId, input.mode, input.name, TOURNAMENT_RULE_VERSION, seed, this.hash(seed), now, rewardProfileId);
    this.users.writeEconomicAudit(input.creatorUserId, "player_tournament.created", "player_tournament", id, input.requestId, { mode: input.mode, ruleVersion: TOURNAMENT_RULE_VERSION, rewardProfileId }, now);
    return id;
  }

  playerTournament(userId: string, tournamentId: string): PlayerTournamentDto | null {
    const tournament = this.playerTournamentRow(tournamentId);
    if (!tournament) return null;
    const isMember = this.database.prepare("SELECT 1 FROM player_tournament_registrations WHERE tournament_id = ? AND user_id = ?").get(tournamentId, userId);
    if (tournament.creator_user_id !== userId && !isMember) return null;
    return this.playerTournamentDto(tournament);
  }

  /** 创建者与报名者均可返回自己参加过的玩家赛事，用于前端历史入口。 */
  playerTournamentList(userId: string): PlayerTournamentDto[] {
    return (this.database.prepare(
      `SELECT tournament.* FROM player_tournaments tournament
       WHERE tournament.creator_user_id = ?
          OR EXISTS (SELECT 1 FROM player_tournament_registrations registration WHERE registration.tournament_id = tournament.id AND registration.user_id = ?)
       ORDER BY tournament.created_at DESC`
    ).all(userId, userId) as PlayerTournamentRow[]).map((tournament) => this.playerTournamentDto(tournament));
  }

  playerRegistrations(userId: string, tournamentId: string): PlayerTournamentRegistrationDto[] | null {
    if (!this.playerTournament(userId, tournamentId)) return null;
    const tournament = this.playerTournamentRow(tournamentId)!;
    return (this.database.prepare("SELECT * FROM player_tournament_registrations WHERE tournament_id = ? ORDER BY created_at, id").all(tournamentId) as PlayerRegistrationRow[])
      .map((registration) => this.playerRegistrationDto(registration, tournament.mode));
  }

  playerRounds(userId: string, tournamentId: string): PlayerTournamentRoundDto[] | null {
    if (!this.playerTournament(userId, tournamentId)) return null;
    const rounds = this.database.prepare(
      "SELECT id, tournament_id, round_number, table_number, stage, status, submitted_by_user_id, confirmed_at FROM player_tournament_rounds WHERE tournament_id = ? ORDER BY round_number, table_number"
    ).all(tournamentId) as Array<{ id: string; tournament_id: string; round_number: number; table_number: number; stage: "normal" | "playoff"; status: "pending" | "submitted" | "confirmed" | "disputed"; submitted_by_user_id: string | null; confirmed_at: string | null }>;
    return rounds.map((round) => ({
      id: round.id,
      tournamentId: round.tournament_id,
      roundNumber: round.round_number,
      tableNumber: round.table_number,
      stage: round.stage,
      status: round.status,
      registrationIds: this.roundPlayers(round.id).map((player) => player.registration_id),
      submittedByUserId: round.submitted_by_user_id,
      confirmedAt: round.confirmed_at
    }));
  }

  playerResult(userId: string, tournamentId: string): PlayerTournamentResultDto | null {
    const result = this.database.prepare(
      `SELECT result.* FROM player_tournament_results result
       JOIN player_tournament_registrations registration ON registration.id = result.registration_id
       WHERE result.player_tournament_id = ? AND registration.user_id = ?`
    ).get(tournamentId, userId) as { player_tournament_id: string; registration_id: string; rank: number; points: number; opponent_points: number; reward_amount: number; settled_at: string } | undefined;
    return result ? { tournamentId: result.player_tournament_id, registrationId: result.registration_id, rank: result.rank, points: result.points, opponentPoints: result.opponent_points, reward: { amount: result.reward_amount, currency: "GAME_CREDIT" }, rewardDetail: this.playerRewardDetail(result.registration_id), settledAt: result.settled_at } : null;
  }

  /** 现实桌只保存玩家填写的名称，绝不读取/保存实体卡组或锁库存。 */
  joinPlayerTournament(input: {
    userId: string;
    tournamentId: string;
    deckName: string;
    requestId: string;
    now?: Date;
  }): string | "not-found" | "closed" | "invalid-mode" | "duplicate" | "missing-archive" {
    const now = (input.now ?? new Date()).toISOString();
    const tournament = this.playerTournamentRow(input.tournamentId);
    if (!tournament) return "not-found";
    if (tournament.mode !== "tabletop") return "invalid-mode";
    if (tournament.status !== "open") return "closed";
    if (!this.users.archive(input.userId)) return "missing-archive";
    const id = randomUUID();
    try {
      this.database.prepare(
        "INSERT INTO player_tournament_registrations (id, tournament_id, user_id, deck_name, status, points, created_at) VALUES (?, ?, ?, ?, 'registered', 0, ?)"
      ).run(id, input.tournamentId, input.userId, input.deckName, now);
    } catch {
      return "duplicate";
    }
    this.users.writeEconomicAudit(input.userId, "player_tournament.tabletop_joined", "player_tournament_registration", id, input.requestId, { tournamentId: input.tournamentId }, now);
    return id;
  }

  /** 外部 Leyline 成功前不写任何游戏内赛事报名、快照或 hold。 */
  async joinGameTournament(input: {
    userId: string;
    tournamentId: string;
    deckId: string;
    idempotencyKey: string;
    requestId: string;
    now?: Date;
  }): Promise<string | "not-found" | "closed" | "invalid-mode" | "duplicate" | "invalid-deck" | "score-unavailable" | "idempotency-conflict" | "in-progress"> {
    const now = (input.now ?? new Date()).toISOString();
    const fingerprint = this.fingerprint({ operation: "game-join", tournamentId: input.tournamentId, deckId: input.deckId });
    const prior = this.idempotency(input.userId, input.idempotencyKey);
    if (prior) return this.gameJoinReplay(prior, fingerprint);

    const tournament = this.playerTournamentRow(input.tournamentId);
    if (!tournament) return "not-found";
    if (tournament.mode !== "game") return "invalid-mode";
    if (tournament.status !== "open") return "closed";
    const evaluatedDeck = this.decks.revalidateForTournament(input.userId, input.deckId, now);
    if (!evaluatedDeck?.legality.valid) return "invalid-deck";
    let evaluation;
    try {
      evaluation = await this.config.leyline.evaluate(evaluatedDeck.cards);
    } catch {
      return "score-unavailable";
    }

    return this.inventory.withLedgerTransaction(() => {
      const raced = this.idempotency(input.userId, input.idempotencyKey);
      if (raced) return this.gameJoinReplay(raced, fingerprint);
      try {
        this.insertRunningIdempotency(input.userId, input.idempotencyKey, fingerprint, now);
      } catch {
        const sameKey = this.idempotency(input.userId, input.idempotencyKey);
        return sameKey ? this.gameJoinReplay(sameKey, fingerprint) : "in-progress";
      }
      const currentTournament = this.playerTournamentRow(input.tournamentId);
      if (!currentTournament) return this.completeString(input.userId, input.idempotencyKey, "not-found", 404, now);
      if (currentTournament.mode !== "game") return this.completeString(input.userId, input.idempotencyKey, "invalid-mode", 409, now);
      if (currentTournament.status !== "open") return this.completeString(input.userId, input.idempotencyKey, "closed", 409, now);
      const currentDeck = this.decks.revalidateForTournament(input.userId, input.deckId, now);
      if (!currentDeck?.legality.valid || !this.sameDeck(evaluatedDeck, currentDeck)) return this.completeString(input.userId, input.idempotencyKey, "invalid-deck", 409, now);
      if (!this.users.archive(input.userId)) return this.completeString(input.userId, input.idempotencyKey, "invalid-deck", 409, now);

      const registrationId = randomUUID();
      try {
        this.database.prepare(
          `INSERT INTO player_tournament_registrations
           (id, tournament_id, user_id, deck_name, deck_id, power_snapshot_id, status, points, created_at)
           VALUES (?, ?, ?, ?, ?, NULL, 'registered', 0, ?)`
        ).run(registrationId, input.tournamentId, input.userId, currentDeck.name, input.deckId, now);
      } catch {
        return this.completeString(input.userId, input.idempotencyKey, "duplicate", 409, now);
      }
      const snapshot = this.decks.saveLeylineSnapshotInTransaction({ userId: input.userId, deckId: input.deckId, registrationId, evaluation, encryptionKey: this.config.encryptionKey, now });
      this.decks.savePlayerTournamentDeckSnapshotInTransaction({ registrationId, deck: currentDeck, now });
      this.database.prepare("UPDATE player_tournament_registrations SET power_snapshot_id = ? WHERE id = ?").run(this.snapshotId(registrationId), registrationId);
      this.lockDeckForPlayerRegistration(input.userId, registrationId, currentDeck, now);
      this.users.writeEconomicAudit(input.userId, "player_tournament.game_joined", "player_tournament_registration", registrationId, input.requestId, { tournamentId: input.tournamentId, powerScore: snapshot.score }, now);
      return this.completeString(input.userId, input.idempotencyKey, registrationId, 201, now);
    });
  }

  /** 游戏内开始命令只入队，结算由唯一任务执行，任务重领不会重复释放或写奖励事实。 */
  startGameTournament(input: { actorUserId: string; tournamentId: string; requestId: string; now?: Date }): "queued" | "not-found" | "forbidden" | "invalid-mode" | "conflict" {
    const now = (input.now ?? new Date()).toISOString();
    const tournament = this.playerTournamentRow(input.tournamentId);
    if (!tournament) return "not-found";
    if (tournament.creator_user_id !== input.actorUserId) return "forbidden";
    if (tournament.mode !== "game") return "invalid-mode";
    if (tournament.status !== "open") return "conflict";
    const count = (this.database.prepare("SELECT COUNT(*) AS count FROM player_tournament_registrations WHERE tournament_id = ? AND status = 'registered'").get(input.tournamentId) as { count: number }).count;
    if (count < 1) return "conflict";
    this.database.prepare("UPDATE player_tournaments SET status = 'in_progress' WHERE id = ? AND status = 'open'").run(input.tournamentId);
    enqueueTournamentSettleJob(this.database, { playerTournamentId: input.tournamentId }, now);
    this.users.writeEconomicAudit(input.actorUserId, "player_tournament.game_started", "player_tournament", input.tournamentId, input.requestId, { registrations: count }, now);
    return "queued";
  }

  /** task runner 唯一调用的游戏内结算入口；无用户输入，不使用浏览器可见 seed。 */
  settleScheduledGameTournament(tournamentId: string, now = new Date()): boolean {
    const iso = now.toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const tournament = this.playerTournamentRow(tournamentId);
      if (!tournament || tournament.mode !== "game") return false;
      if (tournament.status === "settled") return true;
      if (tournament.status !== "in_progress") return false;
      const registrations = this.database.prepare(
        `SELECT registration.id, registration.user_id, registration.power_snapshot_id, snapshot.score
         FROM player_tournament_registrations registration
         JOIN deck_power_snapshots snapshot ON snapshot.id = registration.power_snapshot_id
         WHERE registration.tournament_id = ? AND registration.status = 'registered'
         ORDER BY registration.id`
      ).all(tournamentId) as Array<{ id: string; user_id: string; power_snapshot_id: string; score: number }>;
      if (registrations.length < 1) throw new Error("游戏内赛事没有报名者结算");
      const profile = this.playerRewardProfile(tournament);
      const resolved = resolveGameTournament(tournament.rule_version, registrations.map((registration) => ({ registrationId: registration.id, powerScore: registration.score })), tournament.random_seed, this.playerRewardTieBreakBoundaries(profile.id, registrations.length));
      for (const standing of resolved.standings) {
        const registration = registrations.find((entry) => entry.id === standing.registrationId)!;
        const award = this.grantPlayerTournamentReward({ registrationId: registration.id, userId: registration.user_id, profileId: profile.id, rank: standing.rank, seed: tournament.random_seed, now: iso });
        this.releasePlayerRegistrationHolds(registration.id, registration.user_id, `player-tournament-settled:${registration.id}`, iso);
        this.database.prepare("UPDATE player_tournament_registrations SET points = ?, status = 'eliminated' WHERE id = ? AND status = 'registered'").run(standing.points, registration.id);
        this.database.prepare(
          `INSERT INTO player_tournament_results
           (id, player_tournament_id, registration_id, rank, points, opponent_points, reward_amount, replay_json, settled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(randomUUID(), tournament.id, registration.id, standing.rank, standing.points, standing.opponentPoints, award.amount, JSON.stringify({ matches: resolved.matches, randomSeedHash: tournament.seed_hash, ruleVersion: tournament.rule_version, rewardDetail: award.detail }), iso);
        this.appendTournamentFact({ aggregateType: "player_tournament_registration", aggregateId: registration.id, tournamentId: tournament.id, playerId: registration.user_id, result: standing.rank === 1 ? "win" : "loss", rewardAmount: award.amount, ruleVersion: tournament.rule_version, randomSeedHash: tournament.seed_hash, now: iso });
      }
      this.database.prepare("UPDATE player_tournaments SET status = 'settled', settled_at = ? WHERE id = ? AND status = 'in_progress'").run(iso, tournament.id);
      this.users.writeEconomicAudit(tournament.creator_user_id, "player_tournament.game_settled", "player_tournament", tournament.id, `job:tournament.settle:${tournament.id}`, { registrations: registrations.length, ruleVersion: tournament.rule_version }, iso);
      return true;
    });
  }

  /** 与旧路由兼容的显式结算入口：实际动作仍是投递唯一任务。 */
  settleGameTournament(input: { actorUserId: string; tournamentId: string; requestId: string; now?: Date }): "queued" | "not-found" | "forbidden" | "invalid-mode" | "conflict" {
    return this.startGameTournament(input);
  }

  pairTabletopRound(input: { actorUserId: string; tournamentId: string; requestId: string; now?: Date }): string[] | "not-found" | "forbidden" | "invalid-mode" | "conflict" {
    const now = (input.now ?? new Date()).toISOString();
    const tournament = this.playerTournamentRow(input.tournamentId);
    if (!tournament) return "not-found";
    if (tournament.creator_user_id !== input.actorUserId) return "forbidden";
    if (tournament.mode !== "tabletop") return "invalid-mode";
    if (tournament.status !== "open" && tournament.status !== "in_progress") return "conflict";
    const pending = (this.database.prepare("SELECT COUNT(*) AS count FROM player_tournament_rounds WHERE tournament_id = ? AND status IN ('pending','submitted','disputed')").get(input.tournamentId) as { count: number }).count;
    if (pending > 0) return "conflict";
    const registrations = this.database.prepare("SELECT id, points FROM player_tournament_registrations WHERE tournament_id = ? AND status = 'registered' ORDER BY id").all(input.tournamentId) as Array<{ id: string; points: number }>;
    if (registrations.length === 0) return "conflict";
    const roundNumber = (this.database.prepare("SELECT COALESCE(MAX(round_number), 0) AS value FROM player_tournament_rounds WHERE tournament_id = ?").get(input.tournamentId) as { value: number }).value + 1;
    const groups = pairTabletopSwiss(tournament.rule_version, registrations.map((registration) => ({ registrationId: registration.id, points: registration.points })), `${tournament.random_seed}:round:${roundNumber}`);
    const roundIds: string[] = [];
    for (const [index, group] of groups.entries()) {
      const id = randomUUID();
      this.database.prepare(
        `INSERT INTO player_tournament_rounds
         (id, tournament_id, round_number, table_number, status, result_type, result_json, submitted_by_user_id, created_at, confirmed_at)
         VALUES (?, ?, ?, ?, 'pending', NULL, NULL, NULL, ?, NULL)`
      ).run(id, input.tournamentId, roundNumber, index + 1, now);
      for (const registrationId of group) this.database.prepare("INSERT INTO player_tournament_round_players (round_id, registration_id) VALUES (?, ?)").run(id, registrationId);
      roundIds.push(id);
    }
    this.database.prepare("UPDATE player_tournaments SET status = 'in_progress' WHERE id = ? AND status = 'open'").run(input.tournamentId);
    this.users.writeEconomicAudit(input.actorUserId, "player_tournament.round_paired", "player_tournament", input.tournamentId, input.requestId, { roundNumber, tableCount: roundIds.length }, now);
    return roundIds;
  }

  submitTabletopResult(input: {
    userId: string;
    roundId: string;
    winnerRegistrationId: string | null;
    draw: boolean;
    forfeitedRegistrationIds: string[];
    requestId: string;
    now?: Date;
  }): "ok" | "not-found" | "forbidden" | "conflict" {
    const now = (input.now ?? new Date()).toISOString();
    const round = this.database.prepare("SELECT tournament_id, status FROM player_tournament_rounds WHERE id = ?").get(input.roundId) as { tournament_id: string; status: string } | undefined;
    if (!round) return "not-found";
    if (round.status !== "pending") return "conflict";
    const players = this.roundPlayers(input.roundId);
    if (!players.some((player) => player.user_id === input.userId)) return "forbidden";
    const registrationIds = new Set(players.map((player) => player.registration_id));
    const allForfeited = input.forfeitedRegistrationIds.length === registrationIds.size;
    if (
      (input.winnerRegistrationId && !registrationIds.has(input.winnerRegistrationId)) ||
      input.forfeitedRegistrationIds.some((id) => !registrationIds.has(id)) ||
      new Set(input.forfeitedRegistrationIds).size !== input.forfeitedRegistrationIds.length ||
      (input.draw && input.winnerRegistrationId !== null) ||
      (input.winnerRegistrationId !== null && input.forfeitedRegistrationIds.includes(input.winnerRegistrationId)) ||
      (!input.draw && input.winnerRegistrationId === null && !allForfeited)
    ) return "conflict";
    const resultType = input.draw ? "draw" : input.forfeitedRegistrationIds.length > 0 ? "forfeit" : "winner";
    this.database.prepare("UPDATE player_tournament_rounds SET status = 'submitted', result_type = ?, result_json = ?, submitted_by_user_id = ? WHERE id = ? AND status = 'pending'").run(resultType, JSON.stringify({ winnerRegistrationId: input.winnerRegistrationId, draw: input.draw, forfeitedRegistrationIds: input.forfeitedRegistrationIds }), input.userId, input.roundId);
    for (const player of players) this.database.prepare("UPDATE player_tournament_round_players SET is_winner = ?, forfeited = ? WHERE round_id = ? AND registration_id = ?").run(player.registration_id === input.winnerRegistrationId ? 1 : 0, input.forfeitedRegistrationIds.includes(player.registration_id) ? 1 : 0, input.roundId, player.registration_id);
    this.users.writeEconomicAudit(input.userId, "player_tournament.result_submitted", "player_tournament_round", input.roundId, input.requestId, { resultType }, now);
    return "ok";
  }

  confirmTabletopResult(input: { userId: string; roundId: string; requestId: string; now?: Date }): "ok" | "not-found" | "forbidden" | "conflict" {
    const now = (input.now ?? new Date()).toISOString();
    const round = this.database.prepare("SELECT status, result_json FROM player_tournament_rounds WHERE id = ?").get(input.roundId) as { status: string; result_json: string | null } | undefined;
    if (!round) return "not-found";
    const registration = this.database.prepare(
      `SELECT player.registration_id FROM player_tournament_round_players player
       JOIN player_tournament_registrations registration ON registration.id = player.registration_id
       WHERE player.round_id = ? AND registration.user_id = ?`
    ).get(input.roundId, input.userId) as { registration_id: string } | undefined;
    if (!registration) return "forbidden";
    if (round.status === "confirmed") return "ok";
    if (round.status !== "submitted") return "conflict";
    this.database.prepare("INSERT OR IGNORE INTO player_tournament_round_confirmations (round_id, registration_id, confirmed_at) VALUES (?, ?, ?)").run(input.roundId, registration.registration_id, now);
    const expected = (this.database.prepare("SELECT COUNT(*) AS count FROM player_tournament_round_players WHERE round_id = ?").get(input.roundId) as { count: number }).count;
    const confirmed = (this.database.prepare("SELECT COUNT(*) AS count FROM player_tournament_round_confirmations WHERE round_id = ?").get(input.roundId) as { count: number }).count;
    if (confirmed < expected) return "ok";
    const entries = this.database.prepare("SELECT registration_id, is_winner, forfeited FROM player_tournament_round_players WHERE round_id = ?").all(input.roundId) as Array<{ registration_id: string; is_winner: number; forfeited: number }>;
    const result = round.result_json ? JSON.parse(round.result_json) as { draw?: unknown } : null;
    if (!result || typeof result.draw !== "boolean") throw new Error("现实桌赛果记录损坏");
    const draw = result.draw;
    const points = tabletopPoints(TOURNAMENT_RULE_VERSION, entries.map((entry) => ({ registrationId: entry.registration_id, winner: entry.is_winner === 1, draw, forfeited: entry.forfeited === 1 })));
    for (const award of points) this.database.prepare("UPDATE player_tournament_registrations SET points = points + ? WHERE id = ? AND status = 'registered'").run(award.points, award.registrationId);
    this.database.prepare("UPDATE player_tournament_rounds SET status = 'confirmed', confirmed_at = ? WHERE id = ? AND status = 'submitted'").run(now, input.roundId);
    this.users.writeEconomicAudit(input.userId, "player_tournament.result_confirmed", "player_tournament_round", input.roundId, input.requestId, { confirmations: confirmed }, now);
    return "ok";
  }

  withdrawPlayerTournament(input: { userId: string; tournamentId: string; requestId: string; now?: Date }): "ok" | "not-found" | "conflict" {
    const now = (input.now ?? new Date()).toISOString();
    const tournament = this.playerTournamentRow(input.tournamentId);
    if (!tournament) return "not-found";
    if (tournament.status === "settled" || tournament.status === "cancelled") return "conflict";
    const registration = this.database.prepare("SELECT * FROM player_tournament_registrations WHERE tournament_id = ? AND user_id = ?").get(input.tournamentId, input.userId) as PlayerRegistrationRow | undefined;
    if (!registration || registration.status !== "registered") return "conflict";
    if (tournament.mode === "game") this.releasePlayerRegistrationHolds(registration.id, registration.user_id, `player-tournament-withdraw:${registration.id}`, now);
    this.database.prepare("UPDATE player_tournament_registrations SET status = 'withdrawn' WHERE id = ? AND status = 'registered'").run(registration.id);
    this.database.prepare(
      `UPDATE player_tournament_round_players SET forfeited = 1
       WHERE registration_id = ? AND round_id IN (SELECT id FROM player_tournament_rounds WHERE status IN ('pending','submitted'))`
    ).run(registration.id);
    this.users.writeEconomicAudit(input.userId, "player_tournament.withdrawn", "player_tournament_registration", registration.id, input.requestId, { tournamentId: input.tournamentId }, now);
    return "ok";
  }

  openDispute(input: { userId: string; roundId: string; reason: string; requestId: string; now?: Date }): string | "not-found" | "forbidden" | "conflict" {
    const now = (input.now ?? new Date()).toISOString();
    const round = this.database.prepare("SELECT tournament_id, status FROM player_tournament_rounds WHERE id = ?").get(input.roundId) as { tournament_id: string; status: string } | undefined;
    if (!round) return "not-found";
    if (round.status !== "pending" && round.status !== "submitted") return "conflict";
    const isMember = this.database.prepare(
      `SELECT 1 FROM player_tournament_round_players player
       JOIN player_tournament_registrations registration ON registration.id = player.registration_id
       WHERE player.round_id = ? AND registration.user_id = ?`
    ).get(input.roundId, input.userId);
    if (!isMember) return "forbidden";
    const disputeId = randomUUID();
    try {
      this.database.prepare(
        `INSERT INTO tournament_disputes
         (id, player_tournament_id, round_id, opened_by_user_id, status, reason, resolution_reason, resolved_by_user_id, resolved_at, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, NULL, NULL, NULL, ?)`
      ).run(disputeId, round.tournament_id, input.roundId, input.userId, input.reason, now);
    } catch {
      return "conflict";
    }
    this.database.prepare("UPDATE player_tournament_rounds SET status = 'disputed' WHERE id = ?").run(input.roundId);
    this.database.prepare("UPDATE player_tournaments SET status = 'disputed' WHERE id = ? AND status != 'settled'").run(round.tournament_id);
    this.users.writeEconomicAudit(input.userId, "player_tournament.dispute_opened", "tournament_dispute", disputeId, input.requestId, { roundId: input.roundId }, now);
    return disputeId;
  }

  /** 只允许 admin 路由调用；赋分输入、理由和幂等键均在上层 command 事务中保存。 */
  resolveDispute(input: { adminUserId: string; disputeId: string; awardedPoints: Array<{ registrationId: string; points: number }>; reason: string; requestId: string; now?: Date }): "ok" | "not-found" | "conflict" {
    const now = (input.now ?? new Date()).toISOString();
    const dispute = this.database.prepare("SELECT round_id, player_tournament_id FROM tournament_disputes WHERE id = ? AND status = 'open'").get(input.disputeId) as { round_id: string; player_tournament_id: string } | undefined;
    if (!dispute) return "not-found";
    const players = this.database.prepare("SELECT registration_id FROM player_tournament_round_players WHERE round_id = ?").all(dispute.round_id) as Array<{ registration_id: string }>;
    const expected = new Set(players.map((player) => player.registration_id));
    if (input.awardedPoints.length !== expected.size || new Set(input.awardedPoints.map((award) => award.registrationId)).size !== expected.size || input.awardedPoints.some((award) => !expected.has(award.registrationId) || !Number.isSafeInteger(award.points) || award.points < 0 || award.points > 4)) return "conflict";
    for (const award of input.awardedPoints) this.database.prepare("UPDATE player_tournament_registrations SET points = points + ? WHERE id = ?").run(award.points, award.registrationId);
    this.database.prepare("UPDATE tournament_disputes SET status = 'resolved', resolution_reason = ?, resolved_by_user_id = ?, resolved_at = ? WHERE id = ? AND status = 'open'").run(input.reason, input.adminUserId, now, input.disputeId);
    this.database.prepare("UPDATE player_tournament_rounds SET status = 'confirmed', confirmed_at = ?, result_json = ? WHERE id = ?").run(now, JSON.stringify({ resolvedBy: input.adminUserId, reason: input.reason, awardedPoints: input.awardedPoints }), dispute.round_id);
    this.database.prepare("UPDATE player_tournaments SET status = 'in_progress' WHERE id = ? AND status = 'disputed'").run(dispute.player_tournament_id);
    this.users.writeEconomicAudit(input.adminUserId, "player_tournament.dispute_resolved", "tournament_dispute", input.disputeId, input.requestId, { reason: input.reason, awardedPoints: input.awardedPoints }, now);
    return "ok";
  }

  /** 现实桌全轮确认、无未结争议后由创建者完成排名；不产生卡牌锁或实体卡组数据。 */
  settleTabletopTournament(input: { actorUserId: string; tournamentId: string; requestId: string; now?: Date }): "ok" | "not-found" | "forbidden" | "invalid-mode" | "conflict" {
    const now = (input.now ?? new Date()).toISOString();
    const tournament = this.playerTournamentRow(input.tournamentId);
    if (!tournament) return "not-found";
    if (tournament.creator_user_id !== input.actorUserId) return "forbidden";
    if (tournament.mode !== "tabletop") return "invalid-mode";
    if (tournament.status !== "in_progress") return "conflict";
    const unresolved = (this.database.prepare("SELECT COUNT(*) AS count FROM player_tournament_rounds WHERE tournament_id = ? AND status != 'confirmed'").get(input.tournamentId) as { count: number }).count;
    if (unresolved > 0) return "conflict";
    const registrations = this.database.prepare("SELECT * FROM player_tournament_registrations WHERE tournament_id = ? AND status != 'withdrawn' ORDER BY id").all(input.tournamentId) as PlayerRegistrationRow[];
    if (registrations.length === 0) return "conflict";
    const profile = this.playerRewardProfile(tournament);
    const opponentPoints = new Map(registrations.map((registration) => [registration.id, 0]));
    for (const round of this.database.prepare("SELECT id FROM player_tournament_rounds WHERE tournament_id = ?").all(input.tournamentId) as Array<{ id: string }>) {
      const players = this.database.prepare(
        `SELECT player.registration_id, registration.points FROM player_tournament_round_players player
         JOIN player_tournament_registrations registration ON registration.id = player.registration_id
         WHERE player.round_id = ?`
      ).all(round.id) as Array<{ registration_id: string; points: number }>;
      for (const player of players) opponentPoints.set(player.registration_id, (opponentPoints.get(player.registration_id) ?? 0) + players.filter((other) => other.registration_id !== player.registration_id).reduce((sum, other) => sum + other.points, 0));
    }
    const standings = [...registrations]
      .sort((left, right) => right.points - left.points || (opponentPoints.get(right.id) ?? 0) - (opponentPoints.get(left.id) ?? 0) || this.seededCompare(tournament.random_seed, left.id, right.id));
    const playoffRegistrations = this.playerRewardPlayoffGroup(standings, opponentPoints, this.playerRewardTieBreakBoundaries(profile.id, standings.length));
    if (playoffRegistrations.length > 1) {
      const roundNumber = (this.database.prepare("SELECT COALESCE(MAX(round_number), 0) AS value FROM player_tournament_rounds WHERE tournament_id = ?").get(input.tournamentId) as { value: number }).value + 1;
      const roundId = randomUUID();
      this.database.prepare(
        `INSERT INTO player_tournament_rounds
         (id, tournament_id, round_number, table_number, status, result_type, result_json, submitted_by_user_id, created_at, confirmed_at, stage)
         VALUES (?, ?, ?, 1, 'pending', NULL, NULL, NULL, ?, NULL, 'playoff')`
      ).run(roundId, input.tournamentId, roundNumber, now);
      for (const registrationId of playoffRegistrations) this.database.prepare("INSERT INTO player_tournament_round_players (round_id, registration_id) VALUES (?, ?)").run(roundId, registrationId);
      this.users.writeEconomicAudit(input.actorUserId, "player_tournament.reward_playoff_created", "player_tournament_round", roundId, input.requestId, { tournamentId: input.tournamentId, roundNumber, registrations: playoffRegistrations }, now);
      return "conflict";
    }
    for (const [index, registration] of standings.entries()) {
      const award = this.grantPlayerTournamentReward({ registrationId: registration.id, userId: registration.user_id, profileId: profile.id, rank: index + 1, seed: tournament.random_seed, now });
      this.database.prepare(
        `INSERT INTO player_tournament_results
         (id, player_tournament_id, registration_id, rank, points, opponent_points, reward_amount, replay_json, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), tournament.id, registration.id, index + 1, registration.points, opponentPoints.get(registration.id) ?? 0, award.amount, JSON.stringify({ ruleVersion: tournament.rule_version, randomSeedHash: tournament.seed_hash, rewardDetail: award.detail }), now);
      this.database.prepare("UPDATE player_tournament_registrations SET status = 'eliminated' WHERE id = ? AND status = 'registered'").run(registration.id);
      this.appendTournamentFact({ aggregateType: "player_tournament_registration", aggregateId: registration.id, tournamentId: tournament.id, playerId: registration.user_id, result: index === 0 ? "win" : "loss", rewardAmount: award.amount, ruleVersion: tournament.rule_version, randomSeedHash: tournament.seed_hash, now });
    }
    this.database.prepare("UPDATE player_tournaments SET status = 'settled', settled_at = ? WHERE id = ? AND status = 'in_progress'").run(now, tournament.id);
    this.users.writeEconomicAudit(input.actorUserId, "player_tournament.tabletop_settled", "player_tournament", tournament.id, input.requestId, { rankings: standings.length, ruleVersion: tournament.rule_version }, now);
    return "ok";
  }

  /** 非 NPC seed、完整配对与 replay 永远只经 admin endpoint 返回。 */
  playerTournamentReplayForAdmin(tournamentId: string): unknown | null {
    const tournament = this.playerTournamentRow(tournamentId);
    if (!tournament) return null;
    const results = this.database.prepare("SELECT registration_id, rank, points, opponent_points, replay_json FROM player_tournament_results WHERE player_tournament_id = ? ORDER BY rank").all(tournamentId) as Array<{ registration_id: string; rank: number; points: number; opponent_points: number; replay_json: string }>;
    return { tournamentId: tournament.id, ruleVersion: tournament.rule_version, seed: tournament.random_seed, seedHash: tournament.seed_hash, results: results.map((result) => ({ registrationId: result.registration_id, rank: result.rank, points: result.points, opponentPoints: result.opponent_points, replay: JSON.parse(result.replay_json) as unknown })) };
  }

  async register(input: { userId: string; tournamentId: string; deckId: string; idempotencyKey: string; requestId: string; now?: Date }): Promise<RegistrationCommand> {
    const now = (input.now ?? new Date()).toISOString();
    const fingerprint = this.fingerprint({ operation: "npc-register", tournamentId: input.tournamentId, deckId: input.deckId });
    const prior = this.idempotency(input.userId, input.idempotencyKey);
    if (prior) return this.registrationReplay(prior, fingerprint, input.requestId);
    const evaluatedDeck = this.decks.revalidateForTournament(input.userId, input.deckId, now);
    if (!evaluatedDeck) return this.registrationReply(404, input.requestId, "RESOURCE_NOT_FOUND", "卡组不存在");
    if (!evaluatedDeck.legality.valid) return this.registrationReply(409, input.requestId, "RULE_VIOLATION", "卡组当前不满足报名合法性");
    let evaluation;
    try {
      evaluation = await this.config.leyline.evaluate(evaluatedDeck.cards);
    } catch (error) {
      const failure = error instanceof LeylineEvaluationError ? error : new LeylineEvaluationError("unknown", 1);
      const details = { provider: "leyline", failureReason: failure.reason, attempts: failure.attempts, ...(failure.httpStatus === null ? {} : { httpStatus: failure.httpStatus }) };
      (this.config.logger ?? silentTournamentLogger).warn({ event: "tournament.registration_scoring_failed", requestId: input.requestId, userId: input.userId, tournamentId: input.tournamentId, deckId: input.deckId, ...details }, "Leyline 卡组评分失败");
      return this.registrationReply(503, input.requestId, "SCORING_UNAVAILABLE", scoringFailureMessage(failure.reason), details);
    }
    return this.inventory.withLedgerTransaction(() => {
      const raced = this.idempotency(input.userId, input.idempotencyKey);
      if (raced) return this.registrationReplay(raced, fingerprint, input.requestId);
      try {
        this.insertRunningIdempotency(input.userId, input.idempotencyKey, fingerprint, now);
      } catch {
        const sameKey = this.idempotency(input.userId, input.idempotencyKey);
        return sameKey ? this.registrationReplay(sameKey, fingerprint, input.requestId) : this.registrationReply(409, input.requestId, "IDEMPOTENCY_IN_PROGRESS", "请求正在处理");
      }
      const tournament = this.database.prepare("SELECT * FROM tournaments WHERE id = ? AND owner_user_id = ?").get(input.tournamentId, input.userId) as Tournament | undefined;
      if (!tournament) return this.completeRegistration(input.userId, input.idempotencyKey, now, this.registrationReply(404, input.requestId, "RESOURCE_NOT_FOUND", "赛事不存在"));
      if (tournament.status !== "open" || tournament.opens_at > now || (tournament.cutoff_at && tournament.cutoff_at <= now)) return this.completeRegistration(input.userId, input.idempotencyKey, now, this.registrationReply(409, input.requestId, "RESOURCE_CONFLICT", "赛事尚未开放、已截止或不可报名"));
      if (this.registration(input.userId, tournament.id)) return this.completeRegistration(input.userId, input.idempotencyKey, now, this.registrationReply(409, input.requestId, "RESOURCE_CONFLICT", "同一赛事只能报名一次"));
      if (!this.users.archive(input.userId)) return this.completeRegistration(input.userId, input.idempotencyKey, now, this.registrationReply(409, input.requestId, "RESOURCE_CONFLICT", "请先创建游戏存档"));
      const currentDeck = this.decks.revalidateForTournament(input.userId, input.deckId, now);
      if (!currentDeck?.legality.valid || !this.sameDeck(evaluatedDeck, currentDeck)) return this.completeRegistration(input.userId, input.idempotencyKey, now, this.registrationReply(409, input.requestId, "VERSION_STALE", "卡组或禁牌版本已变化，请重新评估"));
      const template = this.template(tournament.template_id);
      if (!template) throw new Error("赛事模板缺失");
      const registrationId = randomUUID();
      const snapshot = this.decks.saveLeylineSnapshotInTransaction({ userId: input.userId, deckId: input.deckId, registrationId, evaluation, encryptionKey: this.config.encryptionKey, now });
      this.decks.saveTournamentDeckSnapshotInTransaction({ registrationId, deck: currentDeck, now });
      this.database.prepare(
        `INSERT INTO tournament_registrations
         (id, tournament_id, user_id, deck_id, power_snapshot_id, status, entry_fee_amount, entry_fee_hold_id, registered_at, settled_at)
         VALUES (?, ?, ?, ?, ?, 'registered', ?, NULL, ?, NULL)`
      ).run(registrationId, tournament.id, input.userId, input.deckId, this.snapshotId(registrationId), template.entry_fee_amount, now);
      this.lockDeckForNpcRegistration(input.userId, registrationId, currentDeck, now);
      if (template.entry_fee_amount > 0 && this.users.spendForTournamentEntry(input.userId, template.entry_fee_amount, now, `tournament-entry:${registrationId}`) === "insufficient") throw new Error("报名余额不足");
      this.users.writeEconomicAudit(input.userId, "tournament.registered", "tournament_registration", registrationId, input.requestId, { tournamentId: tournament.id, deckId: input.deckId, powerScore: snapshot.score, ruleVersion: tournament.rule_version }, now);
      enqueueTournamentSettleJob(this.database, { registrationId }, template.start_mode === "at_cutoff" ? tournament.cutoff_at! : now);
      return this.completeRegistration(input.userId, input.idempotencyKey, now, { statusCode: 201, response: success(input.requestId, { registration: this.registration(input.userId, tournament.id)! }) });
    });
  }

  /** 个人赛事任务结算：注册状态与结果唯一约束收敛至少一次任务领取为至多一次业务结果。 */
  settleRegistration(registrationId: string, now = new Date()): TournamentSettlementDto | null {
    const iso = now.toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const registration = this.database.prepare("SELECT * FROM tournament_registrations WHERE id = ?").get(registrationId) as Registration | undefined;
      if (!registration) return null;
      if (registration.status !== "registered") return this.settlementForRegistration(registrationId);
      const tournament = this.database.prepare("SELECT * FROM tournaments WHERE id = ?").get(registration.tournament_id) as Tournament | undefined;
      if (!tournament) throw new Error("赛事不存在");
      const template = this.template(tournament.template_id);
      if (!template) throw new Error("赛事模板不存在");
      if (template.start_mode === "at_cutoff" && tournament.cutoff_at && tournament.cutoff_at > iso) return null;
      const snapshot = this.powerSnapshot(registration.power_snapshot_id);
      if (!snapshot || snapshot.availability !== "available") throw new Error("报名评分来源快照不可用");
      const npcs = this.database.prepare("SELECT id, name, power_score FROM tournament_npcs WHERE tournament_id = ? ORDER BY seat").all(tournament.id) as Array<{ id: string; name: string; power_score: number }>;
      const simulation = simulateNpcTournament({ ruleVersion: tournament.rule_version, kind: template.kind, playerScore: snapshot.score, npcs: npcs.map((npc) => ({ id: npc.id, name: npc.name, powerScore: npc.power_score })), seed: tournament.seed, rewardAmount: template.reward_amount, rewardTieBreakBoundaries: this.npcRewardTieBreakBoundaries(template.id, npcs.length + 1) });
      // 玩家在瑞士线外或最终结算时均在同一事务释放；卡牌从不 capture/consume。
      this.releaseNpcRegistrationHolds(registration.id, registration.user_id, `tournament-settled:${registration.id}`, iso);
      const award = this.grantNpcReward({ registrationId: registration.id, userId: registration.user_id, templateId: template.id, rank: simulation.rank, seed: tournament.seed, now: iso });
      this.database.prepare(
        `INSERT INTO tournament_results
         (id, tournament_id, registration_id, rank, wins, draws, losses, points, outcome_json, replay_json, reward_amount, settled_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), tournament.id, registration.id, simulation.rank, simulation.wins, simulation.draws, simulation.losses, simulation.points, JSON.stringify({ rounds: simulation.rounds, byes: simulation.byes, forfeits: simulation.forfeits, advanced: simulation.advanced, rewardDetail: award.detail }), JSON.stringify(simulation.replay), award.amount, iso);
      this.database.prepare("UPDATE tournament_registrations SET status = 'settled', settled_at = ? WHERE id = ? AND status = 'registered'").run(iso, registration.id);
      this.database.prepare("UPDATE tournaments SET status = 'settled', settled_at = ? WHERE id = ? AND status = 'open'").run(iso, tournament.id);
      this.appendTournamentFact({ aggregateType: "tournament_registration", aggregateId: registration.id, tournamentId: tournament.id, playerId: registration.user_id, result: simulation.rank === 1 ? "win" : "loss", rewardAmount: award.amount, ruleVersion: tournament.rule_version, randomSeedHash: tournament.seed_hash, now: iso });
      this.users.writeEconomicAudit(registration.user_id, "tournament.settled", "tournament_registration", registration.id, `job:tournament.settle:${registration.id}`, { rank: simulation.rank, advanced: simulation.advanced, reward: award.detail, ruleVersion: tournament.rule_version }, iso);
      return this.settlementForRegistration(registration.id)!;
    });
  }

  private ensureDailyForUser(userId: string, naturalDate: string, timezone: string, now: string): void {
    const templates = this.database.prepare("SELECT * FROM tournament_templates ORDER BY id").all() as Template[];
    for (const template of templates) {
      const exists = this.database.prepare("SELECT id FROM tournaments WHERE template_id = ? AND natural_date = ? AND owner_user_id = ?").get(template.id, naturalDate, userId);
      if (exists) continue;
      const tournamentId = randomUUID();
      const seed = randomBytes(32).toString("hex");
      const opensAt = this.localTimeAt(naturalDate, timezone, template.opens_at);
      const cutoffAt = template.cutoff_at ? this.localTimeAt(naturalDate, timezone, template.cutoff_at) : null;
      this.database.prepare(
        `INSERT INTO tournaments
         (id, template_id, natural_date, owner_user_id, timezone, status, rule_version, seed, seed_hash, opens_at, cutoff_at, created_at, settled_at)
         VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, NULL)`
      ).run(tournamentId, template.id, naturalDate, userId, timezone, template.version, seed, this.hash(seed), opensAt, cutoffAt, now);
      for (let seat = 1; seat < template.total_seats; seat += 1) {
        this.database.prepare("INSERT INTO tournament_npcs (id, tournament_id, seat, name, power_score) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), tournamentId, seat, `NPC-${seat}`, Math.min(100, 20 + template.difficulty * 8 + seat));
      }
    }
  }

  private playerRewardProfile(tournament: PlayerTournamentRow): PlayerRewardProfile {
    const fallback = tournament.mode === "game" ? "player-game-standard/v1" : "player-tabletop-standard/v1";
    const profile = this.database.prepare("SELECT id, version, mode, tie_policy FROM player_tournament_reward_profiles WHERE id = ?").get(tournament.reward_profile_id ?? fallback) as PlayerRewardProfile | undefined;
    if (!profile || profile.mode !== tournament.mode || profile.version !== tournament.rule_version) throw new Error("玩家赛事奖励配置不可重放");
    return profile;
  }

  private npcRewardTieBreakBoundaries(templateId: string, participantCount: number): number[] {
    const entries = this.database.prepare(
      `SELECT id, reward_kind, amount, pack_id, sku_id, weight, min_rank, max_rank, rule_version
       FROM tournament_reward_pool_entries WHERE template_id = ? ORDER BY id`
    ).all(templateId) as PlayerRewardEntry[];
    const signature = (rank: number) => canonicalizeRequest(entries.filter((entry) => entry.min_rank <= rank && entry.max_rank >= rank).map((entry) => ({ id: entry.id, kind: entry.reward_kind, amount: entry.amount, packId: entry.pack_id, skuId: entry.sku_id, weight: entry.weight, ruleVersion: entry.rule_version })));
    const boundaries: number[] = [];
    for (let rank = 1; rank < participantCount; rank += 1) if (signature(rank) !== signature(rank + 1)) boundaries.push(rank);
    return boundaries;
  }

  /** 只有相邻名次的奖励配置不同才构成必须加赛的奖励分界线。 */
  private playerRewardTieBreakBoundaries(profileId: string, participantCount: number): number[] {
    const entries = this.database.prepare(
      `SELECT id, reward_kind, amount, pack_id, sku_id, weight, min_rank, max_rank, rule_version
       FROM player_tournament_reward_pool_entries WHERE reward_profile_id = ? ORDER BY id`
    ).all(profileId) as PlayerRewardEntry[];
    const signature = (rank: number) => canonicalizeRequest(entries.filter((entry) => entry.min_rank <= rank && entry.max_rank >= rank).map((entry) => ({ id: entry.id, kind: entry.reward_kind, amount: entry.amount, packId: entry.pack_id, skuId: entry.sku_id, weight: entry.weight, ruleVersion: entry.rule_version })));
    const boundaries: number[] = [];
    for (let rank = 1; rank < participantCount; rank += 1) if (signature(rank) !== signature(rank + 1)) boundaries.push(rank);
    return boundaries;
  }

  private playerRewardPlayoffGroup(standings: PlayerRegistrationRow[], opponentPoints: Map<string, number>, boundaries: number[]): string[] {
    for (let start = 0; start < standings.length;) {
      let end = start + 1;
      while (end < standings.length && standings[end]!.points === standings[start]!.points && (opponentPoints.get(standings[end]!.id) ?? 0) === (opponentPoints.get(standings[start]!.id) ?? 0)) end += 1;
      if (boundaries.some((boundary) => boundary >= start + 1 && boundary < end)) return standings.slice(start, end).map((registration) => registration.id);
      start = end;
    }
    return [];
  }

  private playerRewardDetail(registrationId: string): TournamentRewardDetailDto {
    const row = this.database.prepare("SELECT selected_result_json FROM player_tournament_reward_draws WHERE registration_id = ?").get(registrationId) as { selected_result_json: string } | undefined;
    return row ? JSON.parse(row.selected_result_json) as TournamentRewardDetailDto : { kind: "none", amount: 0, packId: null, skuId: null };
  }

  private grantPlayerTournamentReward(input: { registrationId: string; userId: string; profileId: string; rank: number; seed: string; now: string }): Award {
    const entries = this.database.prepare(
      `SELECT id, reward_kind, amount, pack_id, sku_id, weight, min_rank, max_rank, rule_version
       FROM player_tournament_reward_pool_entries
       WHERE reward_profile_id = ? AND min_rank <= ? AND max_rank >= ? ORDER BY id`
    ).all(input.profileId, input.rank, input.rank) as PlayerRewardEntry[];
    if (entries.length === 0) return { amount: 0, detail: { kind: "none", amount: 0, packId: null, skuId: null } };
    const seed = `${input.seed}:${input.registrationId}:player-reward`;
    const selectedId = drawRewardPool(TOURNAMENT_RULE_VERSION, seed, entries.map((entry) => ({ id: entry.id, weight: entry.weight })));
    const selected = entries.find((entry) => entry.id === selectedId)!;
    const detail: TournamentRewardDetailDto = { kind: selected.reward_kind, amount: selected.amount, packId: selected.pack_id, skuId: selected.sku_id };
    const candidates = entries.map((entry) => ({ id: entry.id, kind: entry.reward_kind, amount: entry.amount, packId: entry.pack_id, skuId: entry.sku_id, weight: entry.weight, minRank: entry.min_rank, maxRank: entry.max_rank, ruleVersion: entry.rule_version }));
    this.database.prepare(
      `INSERT INTO player_tournament_reward_draws
       (id, registration_id, pool_entry_id, seed, rule_version, candidates_json, selected_result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), input.registrationId, selected.id, seed, selected.rule_version, JSON.stringify(candidates), JSON.stringify(detail), input.now);
    if (selected.reward_kind === "GAME_CREDIT") {
      if (this.users.funds().creditAvailableFunds(input.userId, selected.amount, input.now, `player-tournament-reward:${input.registrationId}`, "tournament_reward") === "missing") throw new Error("玩家赛事奖励账户不存在");
      this.database.prepare("INSERT INTO player_tournament_rewards (id, registration_id, amount, reason, created_at) VALUES (?, ?, ?, 'pool_game_credit', ?)").run(randomUUID(), input.registrationId, selected.amount, input.now);
      return { amount: selected.amount, detail };
    }
    if (selected.reward_kind === "sku") {
      if (this.inventory.acquireInLedgerTransaction({ userId: input.userId, skuId: selected.sku_id!, quantityDelta: 1, unitCostAmount: 0, reason: "tournament_reward", correlationId: `player-tournament-reward:${input.registrationId}`, now: input.now }) === "insufficient") throw new Error("玩家赛事奖励 SKU 入库失败");
      this.database.prepare("INSERT INTO player_tournament_rewards (id, registration_id, amount, reason, created_at) VALUES (?, ?, 0, 'pool_sku', ?)").run(randomUUID(), input.registrationId, input.now);
      return { amount: 0, detail };
    }
    const pack = this.database.prepare("SELECT id FROM booster_packs WHERE id = ? AND enabled = 1").get(selected.pack_id);
    if (!pack) throw new Error("玩家赛事奖励补充包当前不在售");
    this.database.prepare("INSERT INTO player_tournament_pack_grants (id, registration_id, pack_id, status, created_at, claimed_at) VALUES (?, ?, ?, 'available', ?, NULL)").run(randomUUID(), input.registrationId, selected.pack_id, input.now);
    this.database.prepare("INSERT INTO player_tournament_rewards (id, registration_id, amount, reason, created_at) VALUES (?, ?, 0, 'pool_pack', ?)").run(randomUUID(), input.registrationId, input.now);
    return { amount: 0, detail };
  }

  private grantNpcReward(input: { registrationId: string; userId: string; templateId: string; rank: number; seed: string; now: string }): Award {
    const entries = this.database.prepare(
      `SELECT id, reward_kind, amount, pack_id, sku_id, weight, min_rank, max_rank, rule_version
       FROM tournament_reward_pool_entries
       WHERE template_id = ? AND min_rank <= ? AND max_rank >= ?
       ORDER BY id`
    ).all(input.templateId, input.rank, input.rank) as Array<{ id: string; reward_kind: "GAME_CREDIT" | "pack" | "sku"; amount: number; pack_id: string | null; sku_id: string | null; weight: number; min_rank: number; max_rank: number; rule_version: string }>;
    if (entries.length === 0) return { amount: 0, detail: { kind: "none", amount: 0, packId: null, skuId: null } };
    const seed = `${input.seed}:${input.registrationId}:reward`;
    const selectedId = drawRewardPool(TOURNAMENT_RULE_VERSION, seed, entries.map((entry) => ({ id: entry.id, weight: entry.weight })));
    const selected = entries.find((entry) => entry.id === selectedId)!;
    const candidates = entries.map((entry) => ({ id: entry.id, kind: entry.reward_kind, amount: entry.amount, packId: entry.pack_id, skuId: entry.sku_id, weight: entry.weight, minRank: entry.min_rank, maxRank: entry.max_rank, ruleVersion: entry.rule_version }));
    const detail: TournamentRewardDetailDto = { kind: selected.reward_kind, amount: selected.amount, packId: selected.pack_id, skuId: selected.sku_id };
    this.database.prepare(
      `INSERT INTO tournament_reward_draws
       (id, registration_id, pool_entry_id, seed, rule_version, candidates_json, selected_result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(randomUUID(), input.registrationId, selected.id, seed, selected.rule_version, JSON.stringify(candidates), JSON.stringify(detail), input.now);
    if (selected.reward_kind === "GAME_CREDIT") {
      if (this.users.funds().creditAvailableFunds(input.userId, selected.amount, input.now, `tournament-reward:${input.registrationId}`, "tournament_reward") === "missing") throw new Error("奖励账户不存在");
      this.database.prepare("INSERT INTO tournament_rewards (id, registration_id, amount, reason, created_at) VALUES (?, ?, ?, 'pool_game_credit', ?)").run(randomUUID(), input.registrationId, selected.amount, input.now);
      return { amount: selected.amount, detail };
    }
    if (selected.reward_kind === "sku") {
      if (this.inventory.acquireInLedgerTransaction({ userId: input.userId, skuId: selected.sku_id!, quantityDelta: 1, unitCostAmount: 0, reason: "tournament_reward", correlationId: `tournament-reward:${input.registrationId}`, now: input.now }) === "insufficient") throw new Error("奖励 SKU 入库失败");
      this.database.prepare("INSERT INTO tournament_rewards (id, registration_id, amount, reason, created_at) VALUES (?, ?, 0, 'pool_sku', ?)").run(randomUUID(), input.registrationId, input.now);
      return { amount: 0, detail };
    }
    const pack = this.database.prepare("SELECT id FROM booster_packs WHERE id = ? AND enabled = 1").get(selected.pack_id);
    if (!pack) throw new Error("奖励补充包当前不在售");
    this.database.prepare("INSERT INTO tournament_pack_grants (id, registration_id, pack_id, status, created_at, claimed_at) VALUES (?, ?, ?, 'available', ?, NULL)").run(randomUUID(), input.registrationId, selected.pack_id, input.now);
    this.database.prepare("INSERT INTO tournament_rewards (id, registration_id, amount, reason, created_at) VALUES (?, ?, 0, 'pool_pack', ?)").run(randomUUID(), input.registrationId, input.now);
    return { amount: 0, detail };
  }

  private lockDeckForNpcRegistration(userId: string, registrationId: string, deck: DeckDto, now: string): void {
    for (const card of deck.cards.filter((card) => card.skuId !== null)) {
      const locked = this.inventory.lockInLedgerTransaction({ userId, skuId: card.skuId!, quantity: card.quantity, target: { reason: "tournament", entityType: "tournament_registration", entityId: registrationId }, correlationId: `tournament-registration:${registrationId}`, now });
      if (typeof locked === "string") throw new Error("报名库存不足或已被锁定");
      this.database.prepare("INSERT INTO tournament_registration_holds (registration_id, sku_id, inventory_hold_id) VALUES (?, ?, ?)").run(registrationId, card.skuId, locked.holdId);
    }
  }

  private lockDeckForPlayerRegistration(userId: string, registrationId: string, deck: DeckDto, now: string): void {
    for (const card of deck.cards.filter((card) => card.skuId !== null)) {
      const locked = this.inventory.lockInLedgerTransaction({ userId, skuId: card.skuId!, quantity: card.quantity, target: { reason: "tournament", entityType: "player_tournament_registration", entityId: registrationId }, correlationId: `player-tournament-registration:${registrationId}`, now });
      if (typeof locked === "string") throw new Error("报名库存不足或已被锁定");
      this.database.prepare("INSERT INTO player_tournament_registration_holds (registration_id, sku_id, inventory_hold_id) VALUES (?, ?, ?)").run(registrationId, card.skuId, locked.holdId);
    }
  }

  private releaseNpcRegistrationHolds(registrationId: string, userId: string, correlationId: string, now: string): void {
    const holds = this.database.prepare("SELECT inventory_hold_id FROM tournament_registration_holds WHERE registration_id = ?").all(registrationId) as Array<{ inventory_hold_id: string }>;
    for (const hold of holds) this.inventory.releaseInLedgerTransaction({ userId, holdId: hold.inventory_hold_id, correlationId, now });
  }

  private releasePlayerRegistrationHolds(registrationId: string, userId: string, correlationId: string, now: string): void {
    const holds = this.database.prepare("SELECT inventory_hold_id FROM player_tournament_registration_holds WHERE registration_id = ?").all(registrationId) as Array<{ inventory_hold_id: string }>;
    for (const hold of holds) this.inventory.releaseInLedgerTransaction({ userId, holdId: hold.inventory_hold_id, correlationId, now });
  }

  private appendTournamentFact(input: { aggregateType: string; aggregateId: string; tournamentId: string; playerId: string; result: "win" | "loss"; rewardAmount: number; ruleVersion: string; randomSeedHash: string; now: string }): void {
    const factEventId = randomUUID();
    this.database.prepare(
      "INSERT INTO fact_events (id, event_type, aggregate_type, aggregate_id, version, payload_json, occurred_at) VALUES (?, 'tournament.settled', ?, ?, 1, ?, ?)"
    ).run(factEventId, input.aggregateType, input.aggregateId, JSON.stringify({ tournamentId: input.tournamentId, playerId: input.playerId, result: input.result, reward: { amount: input.rewardAmount, currency: "GAME_CREDIT" }, ruleVersion: input.ruleVersion, randomSeedHash: input.randomSeedHash }), input.now);
    // I26B：成就处理以独立、幂等的 achievement.process 任务消费该 fact；任务至少执行一次，解锁唯一约束收敛至多一次业务结果。
    enqueueAchievementProcessJob(this.database, factEventId, input.now);
  }

  private tournamentDto(tournament: Tournament, userId: string): TournamentDto {
    const template = this.template(tournament.template_id);
    if (!template) throw new Error("赛事模板缺失");
    return { id: tournament.id, templateId: tournament.template_id, naturalDate: tournament.natural_date, kind: template.kind, totalSeats: template.total_seats, entryFee: { amount: template.entry_fee_amount, currency: "GAME_CREDIT" }, difficulty: template.difficulty, entryCondition: template.entry_condition, dailyRegistrationLimit: template.daily_registration_limit, startMode: template.start_mode, opensAt: tournament.opens_at, cutoffAt: tournament.cutoff_at, status: tournament.status, ruleVersion: tournament.rule_version, registered: Boolean(this.registration(userId, tournament.id)), createdAt: tournament.created_at, settledAt: tournament.settled_at };
  }

  private registrationDto(registration: Registration): TournamentRegistrationDto {
    const snapshot = this.powerSnapshot(registration.power_snapshot_id);
    if (!snapshot) throw new Error("报名评分来源快照缺失");
    return { id: registration.id, tournamentId: registration.tournament_id, deckId: registration.deck_id, powerSnapshot: { source: snapshot.source, sourceVersion: snapshot.source_version, providerAlgorithmVersion: snapshot.provider_algorithm_version, score: snapshot.score, inputSummarySha256: snapshot.input_summary_sha256, computedAt: snapshot.computed_at, availability: snapshot.availability, degradationReason: snapshot.degradation_reason, responseSha256: snapshot.response_sha256 }, status: registration.status, registeredAt: registration.registered_at };
  }

  private settlementForRegistration(registrationId: string): TournamentSettlementDto | null {
    const result = this.database.prepare(
      `SELECT result.*, registration.tournament_id FROM tournament_results result
       JOIN tournament_registrations registration ON registration.id = result.registration_id
       WHERE result.registration_id = ?`
    ).get(registrationId) as ResultRow | undefined;
    return result ? this.settlementDto(result) : null;
  }

  private settlementDto(result: ResultRow): TournamentSettlementDto {
    const outcome = JSON.parse(result.outcome_json) as { rounds: TournamentSettlementDto["replay"]["rounds"]; byes: number; forfeits: number; rewardDetail: TournamentRewardDetailDto };
    const replay = JSON.parse(result.replay_json) as Omit<TournamentSettlementDto["replay"], "rounds">;
    return { tournamentId: result.tournament_id, registrationId: result.registration_id, rank: result.rank, wins: result.wins, draws: result.draws, losses: result.losses, byes: outcome.byes, forfeits: outcome.forfeits, points: result.points, reward: { amount: result.reward_amount, currency: "GAME_CREDIT" }, rewardDetail: outcome.rewardDetail, ruleVersion: TOURNAMENT_RULE_VERSION, settledAt: result.settled_at, replay: { ...replay, rounds: outcome.rounds } };
  }

  private playerTournamentDto(row: PlayerTournamentRow): PlayerTournamentDto {
    return { id: row.id, creatorUserId: row.creator_user_id, mode: row.mode, name: row.name, status: row.status, ruleVersion: row.rule_version, createdAt: row.created_at, settledAt: row.settled_at };
  }

  private playerRegistrationDto(row: PlayerRegistrationRow, mode: "game" | "tabletop"): PlayerTournamentRegistrationDto {
    return { id: row.id, tournamentId: row.tournament_id, deckName: row.deck_name, mode, status: row.status, points: row.points, registeredAt: row.created_at };
  }

  private template(templateId: string): Template | null {
    return (this.database.prepare("SELECT * FROM tournament_templates WHERE id = ?").get(templateId) as Template | undefined) ?? null;
  }

  private playerTournamentRow(tournamentId: string): PlayerTournamentRow | null {
    return (this.database.prepare("SELECT * FROM player_tournaments WHERE id = ?").get(tournamentId) as PlayerTournamentRow | undefined) ?? null;
  }

  private powerSnapshot(snapshotId: string): PowerSnapshot | null {
    return (this.database.prepare("SELECT * FROM deck_power_snapshots WHERE id = ?").get(snapshotId) as PowerSnapshot | undefined) ?? null;
  }

  private snapshotId(registrationId: string): string {
    const snapshot = this.database.prepare("SELECT id FROM deck_power_snapshots WHERE registration_id = ?").get(registrationId) as { id: string } | undefined;
    if (!snapshot) throw new Error("报名评分快照未写入");
    return snapshot.id;
  }

  private roundPlayers(roundId: string): Array<{ registration_id: string; user_id: string }> {
    return this.database.prepare(
      `SELECT player.registration_id, registration.user_id FROM player_tournament_round_players player
       JOIN player_tournament_registrations registration ON registration.id = player.registration_id
       WHERE player.round_id = ?`
    ).all(roundId) as Array<{ registration_id: string; user_id: string }>;
  }

  private idempotency(actorId: string, key: string): Idempotency | null {
    return (this.database.prepare("SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?").get(actorId, key) as Idempotency | undefined) ?? null;
  }

  private insertRunningIdempotency(actorId: string, key: string, requestFingerprint: string, now: string): void {
    this.database.prepare(
      "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
    ).run(randomUUID(), actorId, key, requestFingerprint, now);
  }

  private completeCommand<T>(actorId: string, key: string, data: T, now: string): void {
    const updated = this.database.prepare("UPDATE idempotency_requests SET status = 'completed', response_status = 200, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'").run(JSON.stringify(data), now, actorId, key);
    if (updated.changes !== 1) throw new Error("赛事幂等请求状态损坏");
  }

  private commandReplay<T>(row: Idempotency, expectedFingerprint: string): CommandState<T> {
    if (row.request_fingerprint !== expectedFingerprint) return { state: "conflict" };
    if (row.status !== "completed" || !row.response_json) return { state: "in-progress" };
    return { state: "replayed", data: JSON.parse(row.response_json) as T };
  }

  private completeString(actorId: string, key: string, data: string, statusCode: number, now: string): string {
    const updated = this.database.prepare("UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'").run(statusCode, JSON.stringify(data), now, actorId, key);
    if (updated.changes !== 1) throw new Error("赛事幂等请求状态损坏");
    return data;
  }

  private gameJoinReplay(row: Idempotency, fingerprint: string): string | "idempotency-conflict" | "in-progress" {
    if (row.request_fingerprint !== fingerprint) return "idempotency-conflict";
    if (row.status !== "completed" || !row.response_json) return "in-progress";
    return JSON.parse(row.response_json) as string;
  }

  private registrationReplay(row: Idempotency, fingerprint: string, requestId: string): RegistrationCommand {
    if (row.request_fingerprint !== fingerprint) return this.registrationReply(409, requestId, "IDEMPOTENCY_CONFLICT", "同一幂等键对应不同请求");
    if (row.status !== "completed" || !row.response_json || !row.response_status) return this.registrationReply(409, requestId, "IDEMPOTENCY_IN_PROGRESS", "请求正在处理");
    const response = JSON.parse(row.response_json) as ApiResponse<{ registration: TournamentRegistrationDto }>;
    response.meta.requestId = requestId;
    return { statusCode: row.response_status, response };
  }

  private completeRegistration(actorId: string, key: string, now: string, command: RegistrationCommand): RegistrationCommand {
    const updated = this.database.prepare("UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'").run(command.statusCode, JSON.stringify(command.response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("赛事报名幂等请求状态损坏");
    return command;
  }

  private registrationReply(statusCode: number, requestId: string, code: ApiErrorCode, message: string, details?: Record<string, unknown>): RegistrationCommand {
    return { statusCode, response: failure(requestId, code, message, details) as ApiResponse<{ registration: TournamentRegistrationDto }> };
  }

  private packClaimReplay(row: Idempotency, fingerprint: string, requestId: string): PackClaimCommand {
    if (row.request_fingerprint !== fingerprint) return this.packClaimReply(409, requestId, "IDEMPOTENCY_CONFLICT", "同一幂等键对应不同请求");
    if (row.status !== "completed" || !row.response_json || !row.response_status) return this.packClaimReply(409, requestId, "IDEMPOTENCY_IN_PROGRESS", "请求正在处理");
    const response = JSON.parse(row.response_json) as ApiResponse<{ opening: PackOpeningDto }>;
    response.meta.requestId = requestId;
    return { statusCode: row.response_status, response };
  }

  private completePackClaim(actorId: string, key: string, now: string, command: PackClaimCommand): PackClaimCommand {
    const updated = this.database.prepare("UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'").run(command.statusCode, JSON.stringify(command.response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("奖励补充包幂等请求状态损坏");
    return command;
  }

  private packClaimReply(statusCode: number, requestId: string, code: ApiErrorCode, message: string): PackClaimCommand {
    return { statusCode, response: failure(requestId, code, message) as ApiResponse<{ opening: PackOpeningDto }> };
  }

  private fingerprint(body: unknown): string {
    return this.hash(canonicalizeRequest(body));
  }

  private hash(value: string): string {
    return createHash("sha256").update(value).digest("hex");
  }

  private sameDeck(left: DeckDto, right: DeckDto): boolean {
    return canonicalizeRequest(left.cards.map((card) => ({ zone: card.zone, skuId: card.skuId, virtualBasic: card.virtualBasic, quantity: card.quantity }))) === canonicalizeRequest(right.cards.map((card) => ({ zone: card.zone, skuId: card.skuId, virtualBasic: card.virtualBasic, quantity: card.quantity })));
  }

  private localTimeAt(naturalDate: string, timezone: string, time: string): string {
    const match = /^(\d{2}):(\d{2})$/.exec(time);
    if (!match) throw new Error("赛事模板时间格式无效");
    const [year, month, day] = naturalDate.split("-").map(Number);
    if (!year || !month || !day) throw new Error("赛事模板自然日无效");
    const target = Date.UTC(year, month - 1, day, Number(match[1]), Number(match[2]));
    let guess = target;
    const formatter = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const parts = formatter.formatToParts(new Date(guess));
      const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
      const observed = Date.UTC(value("year"), value("month") - 1, value("day"), value("hour"), value("minute"));
      const difference = target - observed;
      if (difference === 0) return new Date(guess).toISOString();
      guess += difference;
    }
    // 不存在的本地夏令时刻会收敛到该时区实际的下一个时刻；模板配置不允许静默写无效 ISO。
    return new Date(guess).toISOString();
  }

  private seededCompare(seed: string, leftId: string, rightId: string): number {
    return this.hash(`${seed}:${leftId}`).localeCompare(this.hash(`${seed}:${rightId}`)) || leftId.localeCompare(rightId);
  }
}

function scoringFailureMessage(reason: LeylineEvaluationError["reason"]): string {
  return {
    timeout: "卡组评分请求超时，请稍后重试",
    network: "卡组评分服务网络连接失败，请稍后重试",
    http_status: "卡组评分服务响应异常，请稍后重试",
    invalid_json: "卡组评分服务返回的 JSON 无效，请稍后重试",
    invalid_schema: "卡组评分服务返回结构不合法，请稍后重试",
    unknown: "卡组评分服务暂不可用，请稍后重试"
  }[reason];
}
