import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalizeRequest,
  type ApiResponse,
  type DailyWorkFundingDto,
  type DailyWorkFundingStatusDto,
  type GameArchiveSummaryDto
} from "@mtg-market/contracts";
import { INITIAL_FUNDING_RULE_VERSION, resolveDailyWorkFunding, resolveInitialFunding } from "@mtg-market/rules";
import type { FundHoldTarget } from "../domain/funds.js";
import { withinTransaction } from "@mtg-market/database";
import { SqliteUserRepository } from "../infrastructure/sqlite-user-repository.js";
import { success } from "../../../shared/http/api-response.js";
import { naturalDateAt, nextNaturalDate, startOfNaturalDate } from "../domain/natural-day.js";

export interface DailyWorkFundingConfig {
  timezone: string;
  ruleVersion: string;
}

export const DEFAULT_DAILY_WORK_FUNDING_CONFIG: DailyWorkFundingConfig = {
  timezone: "Asia/Shanghai",
  ruleVersion: "daily-work-funds/v1"
};

export type ArchiveCreationResult =
  | { state: "created"; response: ApiResponse<{ archive: GameArchiveSummaryDto }> }
  | { state: "replayed"; response: ApiResponse<{ archive: GameArchiveSummaryDto }> }
  | { state: "conflict" }
  | { state: "in-progress" };

export type DailyWorkFundingClaimResult =
  | { state: "claimed"; response: ApiResponse<{ funding: DailyWorkFundingDto }> }
  | { state: "replayed"; response: ApiResponse<{ funding: DailyWorkFundingDto }> }
  | { state: "conflict" }
  | { state: "in-progress" }
  | { state: "not-open" }
  | { state: "archive-required" }
  | { state: "already-claimed" };

/** 存档用例：同一短事务内创建存档、账户、初始账本和业务审计，并持久化幂等响应。 */
export class UserService {
  private readonly users: SqliteUserRepository;
  constructor(private readonly database: Database.Database, private readonly dailyWorkFundingConfig: DailyWorkFundingConfig = DEFAULT_DAILY_WORK_FUNDING_CONFIG) {
    this.users = new SqliteUserRepository(database);
  }

  createArchive(input: {
    userId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): ArchiveCreationResult {
    const now = (input.now ?? new Date()).toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.database
        .prepare(
          "SELECT request_fingerprint, status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
        )
        .get(input.userId, input.idempotencyKey) as
        | { request_fingerprint: string; status: string; response_json: string | null }
        | undefined;
      if (existing) return this.idempotencyResult(existing, input.requestFingerprint);
      try {
        this.database
          .prepare(
            "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
          )
          .run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.database
          .prepare(
            "SELECT request_fingerprint, status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
          )
          .get(input.userId, input.idempotencyKey) as
          | { request_fingerprint: string; status: string; response_json: string | null }
          | undefined;
        return raced
          ? this.idempotencyResult(raced, input.requestFingerprint)
          : { state: "in-progress" };
      }

      const existingArchive = this.users.findArchive(input.userId);
      const archive =
        existingArchive ??
        this.users.createArchive(
          input.userId,
          INITIAL_FUNDING_RULE_VERSION,
          resolveInitialFunding(INITIAL_FUNDING_RULE_VERSION).amount,
          now,
          `archive:${input.userId}`
        );
      if (!existingArchive) {
        this.users.writeAudit(
          input.userId,
          "archive.created",
          "game_archive",
          archive.id,
          input.requestId,
          {
            initialFundingRuleVersion: archive.initialFundingRuleVersion,
            initialAmount: archive.balance.total.amount
          },
          now
        );
      }
      const response = success(input.requestId, { archive });
      this.database
        .prepare(
          "UPDATE idempotency_requests SET status = 'completed', response_status = 201, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
        )
        .run(JSON.stringify(response), now, input.userId, input.idempotencyKey);
      return { state: "created", response };
    });
  }

  archive(userId: string): GameArchiveSummaryDto | null {
    return this.users.findArchive(userId);
  }
  balance(userId: string) {
    return this.users.getBalance(userId);
  }
  ledger(userId: string, cursor: string | undefined, limit: number) {
    return this.users.listLedger(userId, cursor, limit);
  }

  dailyWorkFundingStatus(userId: string, now = new Date()): DailyWorkFundingStatusDto {
    const naturalDate = naturalDateAt(now, this.dailyWorkFundingConfig.timezone);
    const rollover = this.users.findDailyRollover(naturalDate);
    const claim = this.users.findDailyWorkFunding(userId, naturalDate);
    const nextEligibleAt = startOfNaturalDate(nextNaturalDate(naturalDate), this.dailyWorkFundingConfig.timezone);
    if (!this.users.findArchive(userId)) {
      return { naturalDate, timezone: this.dailyWorkFundingConfig.timezone, status: "archive_required", amount: null, ruleVersion: null, openedAt: rollover?.opened_at ?? null, nextEligibleAt, claim: null };
    }
    if (!rollover || rollover.timezone !== this.dailyWorkFundingConfig.timezone) {
      return { naturalDate, timezone: this.dailyWorkFundingConfig.timezone, status: "not_open", amount: null, ruleVersion: null, openedAt: null, nextEligibleAt, claim: null };
    }
    return {
      naturalDate,
      timezone: rollover.timezone,
      status: claim ? "claimed" : "available",
      amount: { amount: rollover.work_funding_amount, currency: "GAME_CREDIT" },
      ruleVersion: rollover.work_funding_rule_version,
      openedAt: rollover.opened_at,
      nextEligibleAt,
      claim
    };
  }

  /** I23B：领取只在当日资格已由 daily.rollover 开放时发生；日切本身绝不批量入账。 */
  claimDailyWorkFunding(input: {
    userId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): DailyWorkFundingClaimResult {
    const now = (input.now ?? new Date()).toISOString();
    const naturalDate = naturalDateAt(new Date(now), this.dailyWorkFundingConfig.timezone);
    return withinTransaction(this.database, () => {
      const existing = this.database.prepare(
        "SELECT request_fingerprint, status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
      ).get(input.userId, input.idempotencyKey) as { request_fingerprint: string; status: string; response_json: string | null } | undefined;
      if (existing) return this.dailyFundingIdempotencyResult(existing, input.requestFingerprint);
      if (!this.users.findArchive(input.userId)) return { state: "archive-required" };
      const rollover = this.users.findDailyRollover(naturalDate);
      if (!rollover || rollover.timezone !== this.dailyWorkFundingConfig.timezone) return { state: "not-open" };
      if (this.users.findDailyWorkFunding(input.userId, naturalDate)) return { state: "already-claimed" };
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.database.prepare(
          "SELECT request_fingerprint, status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
        ).get(input.userId, input.idempotencyKey) as { request_fingerprint: string; status: string; response_json: string | null } | undefined;
        return raced ? this.dailyFundingIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }
      const amount = resolveDailyWorkFunding(rollover.work_funding_rule_version).amount;
      if (amount !== rollover.work_funding_amount) throw new Error("每日工作资金规则快照金额不一致");
      const balance = this.users.creditAvailableFunds(input.userId, amount, now, `daily-work-funding:${input.userId}:${naturalDate}`, "daily_work_funding");
      if (balance === "missing") throw new Error("领取工作资金时资金账户不存在");
      const funding = this.users.createDailyWorkFunding({ rolloverId: rollover.id, userId: input.userId, naturalDate, ruleVersion: rollover.work_funding_rule_version, amount, idempotencyKey: input.idempotencyKey, claimedAt: now });
      this.users.writeAudit(input.userId, "daily_work_funding.claimed", "daily_work_funding_claim", funding.id, input.requestId, { naturalDate, timezone: rollover.timezone, ruleVersion: funding.ruleVersion, amount }, now);
      const response = success(input.requestId, { funding });
      this.database.prepare(
        "UPDATE idempotency_requests SET status = 'completed', response_status = 201, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
      ).run(JSON.stringify(response), now, input.userId, input.idempotencyKey);
      return { state: "claimed", response };
    });
  }
  /** 供开包等已结算经济用例在其外层短事务中调用；不暴露 SQLite 适配器。 */
  spendAvailableFunds(userId: string, amount: number, now: string, correlationId: string) {
    return this.users.spendAvailableFunds(userId, amount, now, correlationId);
  }
  /** 比赛报名费仅由 Tournament application 在同一经济事务内调用。 */
  spendForTournamentEntry(userId: string, amount: number, now: string, correlationId: string) {
    return this.users.spendAvailableFunds(userId, amount, now, correlationId, "tournament_entry");
  }
  /** NPC 买入的命名补偿入口；账本仍只由 users 模块写入。 */
  spendForNpcBuy(userId: string, amount: number, now: string, correlationId: string) {
    return this.users.spendAvailableFunds(userId, amount, now, correlationId, "npc_buy");
  }
  /** NPC 卖出的命名收入入口；账本仍只由 users 模块写入。 */
  creditForNpcSell(userId: string, amount: number, now: string, correlationId: string) {
    return this.users.creditAvailableFunds(userId, amount, now, correlationId, "npc_sell");
  }
  /** I18B 双边委托的资金预占入口；必须在 OrderService 经济短事务回调内调用。 */
  reserveOrderFunds(userId: string, amount: number, target: FundHoldTarget, now: string) {
    return this.users.reserveFunds(userId, amount, target, now);
  }
  /** I18B 双边委托撤单的资金释放入口；仅在 OrderService 经济短事务回调内调用。 */
  releaseOrderFunds(userId: string, holdId: string, now: string) {
    return this.users.releaseFunds(userId, holdId, now);
  }
  writeEconomicAudit(
    actorId: string | null,
    action: string,
    entityType: string,
    entityId: string,
    requestId: string,
    summary: Record<string, unknown>,
    now: string
  ): void {
    this.users.writeAudit(actorId, action, entityType, entityId, requestId, summary, now);
  }
  /** I07B 测试夹具使用的受限资金原语访问；业务模块应使用上方命名 application 命令。 */
  funds(): SqliteUserRepository {
    return this.users;
  }

  private idempotencyResult(
    existing: { request_fingerprint: string; status: string; response_json: string | null },
    fingerprint: string
  ): ArchiveCreationResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_json) return { state: "in-progress" };
    return {
      state: "replayed",
      response: JSON.parse(existing.response_json) as ApiResponse<{
        archive: GameArchiveSummaryDto;
      }>
    };
  }

  private dailyFundingIdempotencyResult(
    existing: { request_fingerprint: string; status: string; response_json: string | null },
    fingerprint: string
  ): DailyWorkFundingClaimResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", response: JSON.parse(existing.response_json) as ApiResponse<{ funding: DailyWorkFundingDto }> };
  }
}

export function archiveRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}
