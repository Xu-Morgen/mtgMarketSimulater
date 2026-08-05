import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalizeRequest,
  type ApiResponse,
  type OnboardingDto,
  type OnboardingRewardClaimDto,
  type OnboardingRewardStatusDto,
  type OnboardingStepCompletionKindDto
} from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";
import {
  ONBOARDING_RULE_VERSION,
  resolveOnboardingReward,
  resolveOnboardingSteps,
  isViewEventStepMatch,
  applyOnboardingAdvance,
  type OnboardingStepDefinition
} from "@mtg-market/rules";
import { failure, success } from "../../../shared/http/api-response.js";

type ProgressRow = {
  completed_at: string | null;
  skipped_at: string | null;
};
type RewardRow = { amount: number; rule_version: string; claimed_at: string };
type IdempotencyRow = { request_fingerprint: string; status: string; response_status: number | null; response_json: string | null };

/** 引导写命令（跳过 / 查看价格历史 / 领取完成奖励）统一结果；全部在短事务内完成并持久化幂等响应。 */
export type OnboardingCommandResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<{ onboarding: OnboardingDto } | { reward: OnboardingRewardClaimDto }> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<{ onboarding: OnboardingDto } | { reward: OnboardingRewardClaimDto }> }
  | { state: "conflict" }
  | { state: "in-progress" };

/**
 * I36B 新手引导用例。步骤进度只由服务端推进：
 * - `fact` 步骤由已结算事实（pack.opened/npc.trade.settled）的同事务幂等消费者推进，
 *   `onboarding_progress` 的 completed_at 冻结保证重放同一事实不重复计数（与 I35B 任务同理）；
 * - `profile` 步骤由服务端对已结算状态（账本/库存/报名表）快照判定，满足即完成、只升不降；
 * - `view_event` 步骤由浏览器提交访问意图、服务端记录 `onboarding_events` 后完成；
 * - 跳过永久记为已完成（老玩家补完目标链与领取奖励的路径）。
 * 全部步骤完成后的固定一次性奖励经账本不可变流水发放，`onboarding_reward_grants` 的
 * PRIMARY KEY(user_id) 与幂等键收敛并发，绝不重复发放。浏览器不得判定完成或结算奖励。
 */
export class OnboardingService {
  private readonly steps: Map<string, OnboardingStepDefinition>;
  private readonly orderedSteps: OnboardingStepDefinition[];

  constructor(private readonly database: Database.Database) {
    this.orderedSteps = resolveOnboardingSteps(ONBOARDING_RULE_VERSION);
    this.steps = new Map(this.orderedSteps.map((step) => [step.id, step]));
  }

  /** 消费一条已写入的已结算事实，推进受影响的 fact 步骤并刷新 profile 步骤；必须在调用方经济事务内执行。 */
  advanceFromFact(factId: string): void {
    const fact = this.database.prepare(
      "SELECT id, event_type, aggregate_type, aggregate_id, payload_json, occurred_at FROM fact_events WHERE id = ?"
    ).get(factId) as { id: string; event_type: string; aggregate_type: string; aggregate_id: string; payload_json: string; occurred_at: string } | undefined;
    if (!fact) throw new Error(`引导推进事实不存在：${factId}`);
    const now = fact.occurred_at;
    for (const userId of this.usersForFact(fact)) {
      for (const step of this.orderedSteps) {
        if (step.source === "fact" && step.factEventType === fact.event_type) {
          this.advanceFactStep(userId, step, now);
        }
        if (step.source === "profile") {
          this.refreshProfileStep(userId, step, now);
        }
      }
    }
  }

  /** 引导只读投影：全部步骤、完成度、下一步与完成奖励状态。刷新 profile 步骤以持久化已满足状态。 */
  overview(userId: string, now: Date = new Date()): OnboardingDto {
    const nowIso = now.toISOString();
    for (const step of this.orderedSteps) {
      if (step.source === "profile") this.refreshProfileStep(userId, step, nowIso);
    }
    return this.projection(userId, nowIso);
  }

  /** 玩家首页只读判定：引导未全部完成或完成奖励未领取时返回 true（纯读，不写快照）。 */
  hasIncompleteOnboarding(userId: string): boolean {
    if (!this.rewardGrant(userId)) return true;
    for (const step of this.orderedSteps) {
      const row = this.progressRow(userId, step.id);
      if (row?.completed_at || row?.skipped_at) continue;
      if (step.source === "profile" && this.profileSatisfied(step.profileKey!, userId)) continue;
      return true;
    }
    return false;
  }

  /** 跳过引导步骤：永久视为已完成（老玩家补完路径）；已完成的步骤不可再跳过。 */
  skip(input: {
    userId: string;
    stepId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): OnboardingCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.commandIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.commandIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }
      const step = this.steps.get(input.stepId);
      if (!step) return this.completeFailure(input, now, 404, "RESOURCE_NOT_FOUND", "引导步骤不存在");
      if (!step.skippable) return this.completeFailure(input, now, 409, "RULE_VIOLATION", "该引导步骤不可跳过");
      const row = this.progressRow(input.userId, input.stepId);
      if (row?.completed_at || row?.skipped_at) {
        return this.completeFailure(input, now, 409, "RULE_VIOLATION", "该引导步骤已完成或已跳过");
      }
      this.upsertProgress(input.userId, input.stepId, null, now, now);
      this.writeAudit(input.userId, "onboarding.step.skipped", input.stepId, input.requestId, now);
      const response = success(input.requestId, { onboarding: this.projection(input.userId, now) });
      this.completeIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  /** 提交价格历史页浏览意图（view_event 步骤）：服务端记录访问事件并置完成，重放/重复访问不重复计数。 */
  recordViewEvent(input: {
    userId: string;
    stepId: string;
    path: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): OnboardingCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.commandIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.commandIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }
      const step = this.steps.get(input.stepId);
      if (!step) return this.completeFailure(input, now, 404, "RESOURCE_NOT_FOUND", "引导步骤不存在");
      if (!isViewEventStepMatch(step, input.path)) {
        return this.completeFailure(input, now, 409, "RULE_VIOLATION", "该访问路径与引导步骤不匹配");
      }
      const inserted = this.database.prepare(
        "INSERT OR IGNORE INTO onboarding_events (id, user_id, event_kind, step_id, occurred_at) VALUES (?, ?, 'view', ?, ?)"
      ).run(randomUUID(), input.userId, input.stepId, now);
      if (inserted.changes === 1) {
        const row = this.progressRow(input.userId, input.stepId);
        if (!row?.completed_at && !row?.skipped_at) this.upsertProgress(input.userId, input.stepId, now, null, now);
      }
      this.writeAudit(input.userId, "onboarding.step.viewed", input.stepId, input.requestId, now);
      const response = success(input.requestId, { onboarding: this.projection(input.userId, now) });
      this.completeIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  /** 领取一次性完成奖励：全部步骤完成才可领，PRIMARY KEY(user_id) + 幂等键防重发。 */
  claimReward(input: {
    userId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): OnboardingCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.commandIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.commandIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }
      const existingGrant = this.rewardGrant(input.userId);
      if (existingGrant) {
        return this.completeFailure(input, now, 409, "IDEMPOTENCY_CONFLICT", "引导完成奖励已领取");
      }
      // 完成判定以服务端为准：任何步骤未完成/未跳过都不可领取。
      for (const step of this.orderedSteps) {
        const row = this.progressRow(input.userId, step.id);
        const satisfied = Boolean(row?.completed_at || row?.skipped_at) || (step.source === "profile" && this.profileSatisfied(step.profileKey!, input.userId));
        if (!satisfied) {
          return this.completeFailure(input, now, 409, "RULE_VIOLATION", "尚未完成全部引导步骤");
        }
      }
      const reward = resolveOnboardingReward(ONBOARDING_RULE_VERSION);
      const balance = this.database.prepare("SELECT available_amount FROM accounts WHERE user_id = ?").get(input.userId) as { available_amount: number } | undefined;
      if (!balance) throw new Error("领取引导奖励时资金账户不存在");
      const credited = this.database.prepare(
        "UPDATE accounts SET total_amount = total_amount + ?, available_amount = available_amount + ?, updated_at = ? WHERE user_id = ?"
      ).run(reward.amount, reward.amount, now, input.userId);
      if (credited.changes !== 1) throw new Error("引导完成奖励入账失败");
      this.database.prepare(
        "INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, (SELECT id FROM accounts WHERE user_id = ?), 'credit', ?, ?, 'onboarding_reward', ?, ?)"
      ).run(randomUUID(), input.userId, reward.amount, balance.available_amount + reward.amount, `onboarding-reward:${input.userId}`, now);
      this.database.prepare(
        "INSERT INTO onboarding_reward_grants (user_id, amount, rule_version, claimed_at) VALUES (?, ?, ?, ?)"
      ).run(input.userId, reward.amount, ONBOARDING_RULE_VERSION, now);
      this.writeAudit(input.userId, "onboarding.reward.claimed", input.userId, input.requestId, now);
      const response = success(input.requestId, { reward: this.claimDto(reward.amount, balance.available_amount + reward.amount, now) });
      this.completeIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  /** 消费已结算事实的玩家与 fact 步骤推进值；p2p 从 bilateral_trades 取买卖双方。 */
  private usersForFact(fact: { event_type: string; aggregate_id: string; payload_json: string }): string[] {
    const parsed = JSON.parse(fact.payload_json) as { payload?: Record<string, unknown> } & Record<string, unknown>;
    const payload = (parsed.payload ?? parsed) as Record<string, unknown>;
    if (fact.event_type === "pack.opened") return [payload.userId as string];
    if (fact.event_type === "npc.trade.settled") return [payload.userId as string];
    if (fact.event_type === "p2p.trade.settled") {
      const trade = this.database.prepare("SELECT buyer_user_id, seller_user_id FROM bilateral_trades WHERE id = ?").get(fact.aggregate_id) as { buyer_user_id: string; seller_user_id: string } | undefined;
      if (!trade) throw new Error("p2p.trade.settled 事实缺少对应成交");
      return [trade.buyer_user_id, trade.seller_user_id];
    }
    if (fact.event_type === "tournament.settled") return [payload.playerId as string];
    return [];
  }

  /** fact 步骤累加推进；completed_at 冻结保证重放同一事实不重复计数。 */
  private advanceFactStep(userId: string, step: OnboardingStepDefinition, now: string): void {
    const row = this.progressRow(userId, step.id);
    if (row?.completed_at || row?.skipped_at) return;
    // 首次目标链的 fact 步骤目标均为 1；已完成即冻结，进度不落库（完成判定只以服务端为准）。
    const advanced = applyOnboardingAdvance({ ruleVersion: ONBOARDING_RULE_VERSION, step, previousValue: 0, contribution: 1 });
    if (advanced.achieved) this.upsertProgress(userId, step.id, now, null, now);
  }

  /** profile 步骤按已结算状态快照置完成（只升不降：已完成/已跳过不再改动）。 */
  private refreshProfileStep(userId: string, step: OnboardingStepDefinition, now: string): void {
    const row = this.progressRow(userId, step.id);
    if (row?.completed_at || row?.skipped_at) return;
    if (this.profileSatisfied(step.profileKey!, userId)) this.upsertProgress(userId, step.id, now, null, now);
  }

  /** 已结算状态快照判定（只读查询，浏览器不得参与）：账本领取记录/库存/报名表。 */
  private profileSatisfied(profileKey: string, userId: string): boolean {
    if (profileKey === "work_funds_claimed") {
      const row = this.database.prepare("SELECT 1 FROM daily_work_funding_claims WHERE user_id = ? LIMIT 1").get(userId);
      return Boolean(row);
    }
    if (profileKey === "collection_has_any") {
      const row = this.database.prepare("SELECT 1 FROM inventory_holdings WHERE user_id = ? AND quantity > 0 LIMIT 1").get(userId);
      return Boolean(row);
    }
    if (profileKey === "tournament_registered") {
      const npc = this.database.prepare("SELECT 1 FROM tournament_registrations WHERE user_id = ? LIMIT 1").get(userId);
      if (npc) return true;
      const player = this.database.prepare("SELECT 1 FROM player_tournament_registrations WHERE user_id = ? LIMIT 1").get(userId);
      return Boolean(player);
    }
    return false;
  }

  /** 当前引导投影；全部字段来自服务端已结算结果与持久化进度。 */
  private projection(userId: string, now: string): OnboardingDto {
    const rewardGrant = this.rewardGrant(userId);
    let completedCount = 0;
    let currentStepId: string | null = null;
    const steps: OnboardingDto["steps"] = this.orderedSteps.map((step, index) => {
      const row = this.progressRow(userId, step.id);
      const completion: OnboardingStepCompletionKindDto | null = row?.completed_at ? "auto" : row?.skipped_at ? "skip" : null;
      if (completion !== null) completedCount += 1;
      else if (currentStepId === null) currentStepId = step.id;
      return {
        id: step.id,
        order: index + 1,
        title: step.title,
        description: step.description,
        href: step.href,
        skippable: step.skippable,
        completion,
        completedAt: row?.completed_at ?? null,
        skippedAt: row?.skipped_at ?? null
      };
    });
    const allCompleted = completedCount === this.orderedSteps.length;
    const rewardStatus: OnboardingRewardStatusDto = rewardGrant ? "claimed" : allCompleted ? "available" : "unavailable";
    return {
      ruleVersion: ONBOARDING_RULE_VERSION,
      steps,
      completedCount,
      totalCount: this.orderedSteps.length,
      allCompleted,
      currentStepId: allCompleted ? null : currentStepId,
      reward: {
        status: rewardStatus,
        amount: resolveOnboardingReward(ONBOARDING_RULE_VERSION),
        claimedAt: rewardGrant?.claimed_at ?? null
      },
      updatedAt: now
    };
  }

  private claimDto(amount: number, balanceAfter: number, claimedAt: string): OnboardingRewardClaimDto {
    return {
      status: "claimed",
      reward: { amount, currency: "GAME_CREDIT" },
      balance: { amount: balanceAfter, currency: "GAME_CREDIT" },
      claimedAt
    };
  }

  private progressRow(userId: string, stepId: string): ProgressRow | undefined {
    return this.database.prepare(
      "SELECT completed_at, skipped_at FROM onboarding_progress WHERE user_id = ? AND step_id = ?"
    ).get(userId, stepId) as ProgressRow | undefined;
  }

  private upsertProgress(userId: string, stepId: string, completedAt: string | null, skippedAt: string | null, now: string): void {
    this.database.prepare(
      `INSERT INTO onboarding_progress (user_id, step_id, step_version, completed_at, skipped_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, step_id) DO UPDATE SET
         completed_at = COALESCE(excluded.completed_at, onboarding_progress.completed_at),
         skipped_at = COALESCE(excluded.skipped_at, onboarding_progress.skipped_at),
         updated_at = excluded.updated_at`
    ).run(userId, stepId, ONBOARDING_RULE_VERSION, completedAt, skippedAt, now);
  }

  private rewardGrant(userId: string): RewardRow | undefined {
    return this.database.prepare(
      "SELECT amount, rule_version, claimed_at FROM onboarding_reward_grants WHERE user_id = ?"
    ).get(userId) as RewardRow | undefined;
  }

  private writeAudit(actorId: string, action: string, entityId: string, requestId: string, now: string): void {
    this.database.prepare(
      "INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, ?, 'onboarding_progress', ?, ?, ?, ?)"
    ).run(randomUUID(), actorId, action, entityId, requestId, JSON.stringify({ ruleVersion: ONBOARDING_RULE_VERSION }), now);
  }

  private findIdempotency(actorId: string, key: string): IdempotencyRow | undefined {
    return this.database.prepare(
      "SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
    ).get(actorId, key) as IdempotencyRow | undefined;
  }

  private commandIdempotencyResult(existing: IdempotencyRow, fingerprint: string): OnboardingCommandResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_status || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", statusCode: existing.response_status, response: JSON.parse(existing.response_json) as ApiResponse<{ onboarding: OnboardingDto } | { reward: OnboardingRewardClaimDto }> };
  }

  private completeFailure(input: { userId: string; idempotencyKey: string; requestId: string }, now: string, statusCode: number, code: "RESOURCE_NOT_FOUND" | "RULE_VIOLATION" | "IDEMPOTENCY_CONFLICT", message: string): OnboardingCommandResult {
    const response = failure(input.requestId, code, message);
    this.completeIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeIdempotency(actorId: string, key: string, statusCode: number, response: ApiResponse<{ onboarding: OnboardingDto } | { reward: OnboardingRewardClaimDto }>, now: string): void {
    const updated = this.database.prepare(
      "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
    ).run(statusCode, JSON.stringify(response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("引导命令幂等请求状态损坏");
  }
}

/** 引导写命令指纹：依赖路径参数 stepId（领取完成奖励为空请求体）。 */
export function onboardingCommandRequestFingerprint(params: Record<string, string>): string {
  return createHash("sha256").update(canonicalizeRequest(params)).digest("hex");
}
