import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalizeRequest,
  type ApiResponse,
  type TaskCenterDto,
  type TaskClaimDto,
  type TaskInstanceDto,
  type TaskMetricTypeDto,
  type TaskPeriodKindDto
} from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";
import {
  applyTaskAdvance,
  DAILY_TASK_RULE_VERSION,
  resolveDailyTaskDefinitions,
  type DailyTaskDefinition
} from "@mtg-market/rules";
import { success, failure } from "../../../shared/http/api-response.js";
import { dayPeriodKey, weekPeriodKey } from "../domain/period.js";

type DefinitionRow = {
  id: string;
  period: TaskPeriodKindDto;
  metric_type: TaskMetricTypeDto;
  target_amount: number;
  reward_amount: number;
  title: string;
  description: string;
  rule_version: string;
};
type InstanceRow = {
  id: string;
  user_id: string;
  definition_id: string;
  period_key: string;
  current_value: number;
  status: "pending" | "claimable" | "claimed";
  claimed_at: string | null;
  updated_at: string;
};
type FactRow = {
  id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: string;
  occurred_at: string;
};
type IdempotencyRow = { request_fingerprint: string; status: string; response_status: number | null; response_json: string | null };

export type TaskClaimCommandResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<TaskClaimDto> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<TaskClaimDto> }
  | { state: "conflict" }
  | { state: "in-progress" };

/** 单一事实对一位玩家的推进贡献；trade/npc.sell 同时携带成交张数与卖出笔数。 */
interface Contribution {
  definitionId: string;
  periodKey: string;
  contribution: number;
  state: boolean;
}

/**
 * I35B（F3）每日/每周任务用例。实例进度只由已结算事实（pack.opened/npc.trade.settled/
 * p2p.trade.settled/tournament.settled）的同事务幂等消费者推进——调用方必须已写入该 fact
 * 并在同一经济短事务内调用，重放同一事实不会重复计数；(user_id, definition_id, period_key)
 * 唯一约束收敛并发。奖励为显式领取：达标实例进入 claimable，玩家经幂等命令领取，状态机
 * 与唯一约束保证至多入账一次。
 */
export class TaskService {
  private readonly definitions: Map<string, DailyTaskDefinition>;

  constructor(
    private readonly database: Database.Database,
    private readonly timezone: string
  ) {
    this.definitions = new Map(resolveDailyTaskDefinitions(DAILY_TASK_RULE_VERSION).map((definition) => [definition.id, definition]));
  }

  /** 任务入口：消费一条已写入的已结算事实，推进相关玩家任务实例；必须在调用方经济事务内执行。 */
  advanceFromFact(fact: FactRow): void {
    for (const user of this.usersForFact(fact)) this.advanceFromProfile(user.userId, user.contributions, fact.occurred_at);
  }

  /** 该事实涉及的玩家 ID（供等级同步等协作使用）。 */
  affectedUserIds(fact: FactRow): string[] {
    return this.usersForFact(fact).map((user) => user.userId);
  }

  /** 任务中心只读聚合：今日 + 本周实例（含未创建实例的 0 进度空态）与可领取数。 */
  overview(userId: string, now: Date = new Date()): TaskCenterDto {
    const dailyKey = dayPeriodKey(now, this.timezone);
    const weeklyKey = weekPeriodKey(now, this.timezone);
    const daily = this.periodInstances(userId, "daily", dailyKey);
    const weekly = this.periodInstances(userId, "weekly", weeklyKey);
    const pendingRewardCount = (this.database.prepare(
      "SELECT COUNT(*) AS count FROM task_instances WHERE user_id = ? AND status = 'claimable'"
    ).get(userId) as { count: number }).count;
    return { daily, weekly, pendingRewardCount, period: { day: dailyKey, week: weeklyKey } };
  }

  claim(input: {
    userId: string;
    instanceId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): TaskClaimCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return withinTransaction(this.database, () => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.claimIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.claimIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }

      const instance = this.database.prepare(
        "SELECT id, user_id, definition_id, period_key, current_value, status, claimed_at FROM task_instances WHERE id = ?"
      ).get(input.instanceId) as Pick<InstanceRow, "id" | "user_id" | "definition_id" | "period_key" | "current_value" | "status" | "claimed_at"> | undefined;
      if (!instance || instance.user_id !== input.userId) return this.completeClaimFailure(input, now, 404, "RESOURCE_NOT_FOUND", "该任务实例不存在");
      const definition = this.definitions.get(instance.definition_id);
      if (!definition) throw new Error("任务定义缺失");
      if (instance.status !== "claimable") {
        // 已领取（状态机保证至多一次入账）：同参数重放返回幂等成功；未达标不可领取。
        if (instance.status === "claimed") {
          return this.completeClaimFailure(input, now, 409, "IDEMPOTENCY_CONFLICT", "该任务奖励已领取");
        }
        return this.completeClaimFailure(input, now, 409, "RULE_VIOLATION", "任务尚未完成，无法领取奖励");
      }
      const claimed = this.database.prepare(
        "UPDATE task_instances SET status = 'claimed', claimed_at = ?, claimed_idempotency_key = ?, updated_at = ? WHERE id = ? AND user_id = ? AND status = 'claimable'"
      ).run(now, input.idempotencyKey, now, input.instanceId, input.userId);
      if (claimed.changes !== 1) throw new Error("任务领取状态迁移冲突");
      const balance = this.database.prepare("SELECT available_amount FROM accounts WHERE user_id = ?").get(input.userId) as { available_amount: number } | undefined;
      if (!balance) throw new Error("领取任务奖励时资金账户不存在");
      const credited = this.database.prepare(
        "UPDATE accounts SET total_amount = total_amount + ?, available_amount = available_amount + ?, updated_at = ? WHERE user_id = ?"
      ).run(definition.rewardAmount, definition.rewardAmount, now, input.userId);
      if (credited.changes !== 1) throw new Error("任务奖励入账失败");
      this.database.prepare(
        "INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, (SELECT id FROM accounts WHERE user_id = ?), 'credit', ?, ?, 'task_reward', ?, ?)"
      ).run(randomUUID(), input.userId, definition.rewardAmount, balance.available_amount + definition.rewardAmount, `task-reward:${input.userId}:${input.instanceId}`, now);
      this.database.prepare(
        "INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'task.claimed', 'task_instance', ?, ?, ?, ?)"
      ).run(randomUUID(), input.userId, input.instanceId, input.requestId, JSON.stringify({ definitionId: definition.id, periodKey: instance.period_key, rewardAmount: definition.rewardAmount }), now);
      const response = success(input.requestId, this.claimDto(input.instanceId, "claimed", definition.rewardAmount, balance.available_amount + definition.rewardAmount));
      this.completeClaimIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  /** 按事实类型派生受推进玩家与贡献。p2p 从 bilateral_trades 取买卖双方（各计成交张数）。
   * 每个受推进玩家同时以当前快照推进状态型指标（collection.value=净资产、set.completion=系列最高完成度 bp）。 */
  private usersForFact(fact: FactRow): Array<{ userId: string; contributions: Contribution[] }> {
    const parsed = JSON.parse(fact.payload_json) as { payload?: Record<string, unknown> } & Record<string, unknown>;
    const payload = (parsed.payload ?? parsed) as Record<string, unknown>;
    const periodKeys = { daily: dayPeriodKey(new Date(fact.occurred_at), this.timezone), weekly: weekPeriodKey(new Date(fact.occurred_at), this.timezone) };
    const collectFor = (userId: string, count: Contribution[]): { userId: string; contributions: Contribution[] } => {
      return {
        userId,
        contributions: [
          ...count,
          { definitionId: "daily-collection-2000/v1", periodKey: periodKeys.daily, contribution: this.collectionValue(userId), state: true },
          { definitionId: "weekly-set-80/v1", periodKey: periodKeys.weekly, contribution: this.setCompletionBp(userId), state: true }
        ]
      };
    };
    if (fact.event_type === "pack.opened") {
      const userId = payload.userId as string;
      return [collectFor(userId, [{ definitionId: "daily-open-3/v1", periodKey: periodKeys.daily, contribution: 1, state: false }])];
    }
    if (fact.event_type === "npc.trade.settled") {
      const userId = payload.userId as string;
      const quantity = payload.quantity as number;
      const side = payload.side as string;
      const contributions: Contribution[] = [{ definitionId: "daily-trade-10/v1", periodKey: periodKeys.daily, contribution: quantity, state: false }];
      if (side === "sell") contributions.push({ definitionId: "daily-sell-1/v1", periodKey: periodKeys.daily, contribution: 1, state: false });
      return [collectFor(userId, contributions)];
    }
    if (fact.event_type === "p2p.trade.settled") {
      const trade = this.database.prepare("SELECT buyer_user_id, seller_user_id, quantity FROM bilateral_trades WHERE id = ?").get(fact.aggregate_id) as { buyer_user_id: string; seller_user_id: string; quantity: number } | undefined;
      if (!trade) throw new Error("p2p.trade.settled 事实缺少对应成交");
      const buyerContribution = { definitionId: "daily-trade-10/v1", periodKey: periodKeys.daily, contribution: trade.quantity, state: false };
      return [collectFor(trade.buyer_user_id, [buyerContribution]), collectFor(trade.seller_user_id, [buyerContribution])];
    }
    if (fact.event_type === "tournament.settled") {
      const playerId = payload.playerId as string;
      return [collectFor(playerId, [{ definitionId: "weekly-tournament-3/v1", periodKey: periodKeys.weekly, contribution: 1, state: false }])];
    }
    return [];
  }

  /** 持仓价值：持有卡牌按最新报价估值累加（缺失报价的 SKU 按 0 计，只用于任务进度推进）。 */
  private collectionValue(userId: string): number {
    const holdings = this.database.prepare("SELECT sku_id, quantity FROM inventory_holdings WHERE user_id = ? AND quantity > 0").all(userId) as Array<{ sku_id: string; quantity: number }>;
    let value = 0;
    for (const holding of holdings) {
      const quote = this.database.prepare("SELECT market_price_amount FROM market_quotes WHERE sku_id = ? ORDER BY calculated_at DESC, rowid DESC LIMIT 1").get(holding.sku_id) as { market_price_amount: number } | undefined;
      if (quote) value += quote.market_price_amount * holding.quantity;
    }
    return value;
  }

  /** 系列收集完成度 bp：取该玩家全部系列完成度里程碑进度中的最大值（goal 以 bp 表达，I33B）。 */
  private setCompletionBp(userId: string): number {
    const row = this.database.prepare(
      "SELECT MAX(current_value) AS max_bp FROM achievement_progress WHERE user_id = ? AND definition_id IN ('set-completion-80/v1', 'set-completion-100/v1')"
    ).get(userId) as { max_bp: number | null } | undefined;
    return row?.max_bp ?? 0;
  }

  /** 对一组贡献执行 upsert 推进：状态型取 max，计数型累加；claimed 实例冻结，重放不重复计数。 */
  private advanceFromProfile(userId: string, contributions: Contribution[], now: string): void {
    for (const contribution of contributions) {
      const definition = this.definitions.get(contribution.definitionId);
      if (!definition) continue;
      const row = this.database.prepare(
        "SELECT id, current_value, status FROM task_instances WHERE user_id = ? AND definition_id = ? AND period_key = ?"
      ).get(userId, contribution.definitionId, contribution.periodKey) as Pick<InstanceRow, "id" | "current_value" | "status"> | undefined;
      if (row?.status === "claimed") continue;
      const previous = row?.current_value ?? 0;
      const advanced = applyTaskAdvance({ ruleVersion: DAILY_TASK_RULE_VERSION, definition, previousValue: previous, profile: { contribution: contribution.contribution, state: contribution.state } });
      const status: "pending" | "claimable" = advanced.achieved ? "claimable" : "pending";
      if (row) {
        this.database.prepare(
          "UPDATE task_instances SET current_value = ?, status = ?, updated_at = ? WHERE id = ? AND status != 'claimed'"
        ).run(advanced.newValue, status, now, row.id);
      } else {
        this.database.prepare(
          "INSERT INTO task_instances (id, user_id, definition_id, period_key, current_value, status, claimed_at, claimed_idempotency_key, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)"
        ).run(randomUUID(), userId, contribution.definitionId, contribution.periodKey, advanced.newValue, status, now);
      }
    }
  }

  /** 当前周期的实例列表：LEFT JOIN 定义补 0 进度空态，按定义 id 稳定排序。 */
  private periodInstances(userId: string, period: TaskPeriodKindDto, periodKey: string): TaskInstanceDto[] {
    const rows = this.database.prepare(
      `SELECT d.id AS definition_id, d.period, d.metric_type, d.target_amount, d.reward_amount, d.title, d.description, d.rule_version,
              i.id AS instance_id, i.period_key, i.current_value, i.status, i.claimed_at
       FROM task_definitions d LEFT JOIN task_instances i ON i.definition_id = d.id AND i.user_id = ? AND i.period_key = ?
       WHERE d.period = ? ORDER BY d.id`
    ).all(userId, periodKey, period) as Array<{
      definition_id: string; period: TaskPeriodKindDto; metric_type: TaskMetricTypeDto; target_amount: number; reward_amount: number;
      title: string; description: string; rule_version: string; instance_id: string | null; period_key: string | null;
      current_value: number | null; status: "pending" | "claimable" | "claimed" | null; claimed_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.instance_id ?? "",
      definitionId: row.definition_id,
      period: row.period,
      periodKey: row.period_key ?? periodKey,
      currentValue: row.current_value ?? 0,
      targetAmount: row.target_amount,
      rewardAmount: row.reward_amount,
      status: row.status ?? "pending",
      claimedAt: row.claimed_at
    }));
  }

  private claimDto(instanceId: string, status: "claimed", rewardAmount: number, balanceAfter: number): TaskClaimDto {
    return {
      instanceId,
      status,
      reward: { amount: rewardAmount, currency: "GAME_CREDIT" },
      balance: { amount: balanceAfter, currency: "GAME_CREDIT" }
    };
  }

  private findIdempotency(actorId: string, key: string): IdempotencyRow | undefined {
    return this.database.prepare(
      "SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
    ).get(actorId, key) as IdempotencyRow | undefined;
  }

  private claimIdempotencyResult(existing: IdempotencyRow, fingerprint: string): TaskClaimCommandResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_status || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", statusCode: existing.response_status, response: JSON.parse(existing.response_json) as ApiResponse<TaskClaimDto> };
  }

  private completeClaimFailure(input: { userId: string; idempotencyKey: string; requestId: string }, now: string, statusCode: number, code: "RESOURCE_NOT_FOUND" | "RULE_VIOLATION" | "IDEMPOTENCY_CONFLICT", message: string): TaskClaimCommandResult {
    const response = failure(input.requestId, code, message);
    this.completeClaimIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeClaimIdempotency(actorId: string, key: string, statusCode: number, response: ApiResponse<TaskClaimDto>, now: string): void {
    const updated = this.database.prepare(
      "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
    ).run(statusCode, JSON.stringify(response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("任务领取幂等请求状态损坏");
  }
}

/** 领取命令指纹：依赖路径参数 instanceId。 */
export function taskClaimRequestFingerprint(params: Record<string, string>): string {
  return createHash("sha256").update(canonicalizeRequest(params)).digest("hex");
}

/** 导出供测试核对定义与迁移保持一致。 */
export function taskDefinitions(): DailyTaskDefinition[] {
  return resolveDailyTaskDefinitions(DAILY_TASK_RULE_VERSION);
}

export type { DefinitionRow as TaskDefinitionRow };
export type { FactRow as GrowthFactRow };
