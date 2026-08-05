import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { GrowthCapabilitiesDto, GrowthProfileDto } from "@mtg-market/contracts";
import {
  LEVEL_RULE_VERSION,
  resolveLevelCapabilities,
  resolveLevelExperience,
  resolveLevelUpReward,
  type LevelCapabilities
} from "@mtg-market/rules";

type GrowthRow = {
  user_id: string;
  total_xp: number;
  level: number;
  title: string;
  peak_net_worth_amount: number;
  rule_version: string;
  updated_at: string;
};

/**
 * I35B（F5）等级/声望用例。等级、经验、称号与已解锁能力只由服务端基于已结算事实计算：
 * 净资产峰值（只增不减）、已结算交易张数与系列完成度里程碑贡献经验；玩家可在查看个人页
 * 或每次经济结算时同步。升级奖励在等级首次跨过阈值时于同一事务内发放（correlationId=
 * `level-up:{userId}:{level}`），持久化等级随事务提交保证重复同步不重发。
 */
export class LevelService {
  constructor(private readonly database: Database.Database) {}

  /** 在当前周期为玩家刷新等级快照与升级奖励；必须在调用方经济事务内执行，幂等可重放。 */
  syncForUser(userId: string, now: Date = new Date()): void {
    const nowIso = now.toISOString();
    const peakNetWorth = this.netWorth(userId);
    const settledTrades = this.settledTrades(userId);
    const collectionCompletion = this.collectionCompletion(userId);
    const resolved = resolveLevelExperience({ ruleVersion: LEVEL_RULE_VERSION, peakNetWorthAmount: peakNetWorth, settledTrades, collectionCompletion });
    const existing = this.database.prepare(
      "SELECT level FROM player_growth WHERE user_id = ?"
    ).get(userId) as { level: number } | undefined;
    const previousLevel = existing?.level ?? 1;
    for (let level = previousLevel + 1; level <= resolved.level; level += 1) {
      this.grantLevelUpReward(userId, level, nowIso);
    }
    this.database.prepare(
      `INSERT INTO player_growth (user_id, total_xp, level, title, peak_net_worth_amount, rule_version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         total_xp = excluded.total_xp,
         level = excluded.level,
         title = excluded.title,
         peak_net_worth_amount = MAX(player_growth.peak_net_worth_amount, excluded.peak_net_worth_amount),
         rule_version = excluded.rule_version,
         updated_at = excluded.updated_at`
    ).run(userId, resolved.totalXp, resolved.level, resolved.title, peakNetWorth, LEVEL_RULE_VERSION, nowIso);
  }

  /** 玩家当前等级能力（无成长记录视为等级 1，与引入等级系统前行为一致）；仅读取，无副作用。 */
  capabilities(userId: string): GrowthCapabilitiesDto {
    const row = this.database.prepare("SELECT level FROM player_growth WHERE user_id = ?").get(userId) as { level: number } | undefined;
    const capabilities = resolveLevelCapabilities(row?.level ?? 1);
    return { npcDailyTradeMultiplier: capabilities.npcDailyTradeMultiplier, bulkPackMax: capabilities.bulkPackMax };
  }

  /** 等级/声望个人页：先按当前已结算事实刷新快照，再返回服务端计算的全量档案。 */
  profile(userId: string, now: Date = new Date()): GrowthProfileDto {
    this.syncForUser(userId, now);
    const row = this.database.prepare(
      "SELECT total_xp, level, title, peak_net_worth_amount, rule_version, updated_at FROM player_growth WHERE user_id = ?"
    ).get(userId) as Omit<GrowthRow, "user_id"> | undefined;
    if (!row) throw new Error("等级档案缺失");
    const resolved = resolveLevelExperience({
      ruleVersion: LEVEL_RULE_VERSION,
      peakNetWorthAmount: row.peak_net_worth_amount,
      settledTrades: this.settledTrades(userId),
      collectionCompletion: this.collectionCompletion(userId)
    });
    return {
      level: row.level,
      title: row.title,
      totalXp: row.total_xp,
      nextLevelXp: resolved.nextLevelXp,
      progressBasisPoints: resolved.progressBasisPoints,
      capabilities: this.capabilities(userId),
      peakNetWorth: { amount: row.peak_net_worth_amount, currency: "GAME_CREDIT" },
      ruleVersion: row.rule_version,
      updatedAt: row.updated_at
    };
  }

  /** 净资产 = 账户总额 + 持仓按最新报价估值（缺失报价的 SKU 按 0 计）。 */
  private netWorth(userId: string): number {
    const account = this.database.prepare("SELECT total_amount FROM accounts WHERE user_id = ?").get(userId) as { total_amount: number } | undefined;
    let value = account?.total_amount ?? 0;
    const holdings = this.database.prepare("SELECT sku_id, quantity FROM inventory_holdings WHERE user_id = ? AND quantity > 0").all(userId) as Array<{ sku_id: string; quantity: number }>;
    for (const holding of holdings) {
      const quote = this.database.prepare("SELECT market_price_amount FROM market_quotes WHERE sku_id = ? ORDER BY calculated_at DESC, rowid DESC LIMIT 1").get(holding.sku_id) as { market_price_amount: number } | undefined;
      if (quote) value += quote.market_price_amount * holding.quantity;
    }
    return value;
  }

  /** 已结算交易张数：NPC 买卖成交张数 + 已履约双边成交张数（单调，取消/过期不计入）。 */
  private settledTrades(userId: string): number {
    const npc = this.database.prepare("SELECT COALESCE(SUM(quantity), 0) AS quantity FROM npc_trades WHERE user_id = ?").get(userId) as { quantity: number };
    const p2p = this.database.prepare("SELECT COALESCE(SUM(quantity), 0) AS quantity FROM bilateral_trades WHERE (buyer_user_id = ? OR seller_user_id = ?) AND status = 'fulfilled'").get(userId, userId) as { quantity: number };
    return npc.quantity + p2p.quantity;
  }

  /** 收藏完成度里程碑：系列完成度 80% 与 100% 里程碑各自是否已达成（进度以 bp 表达，I33B）。 */
  private collectionCompletion(userId: string): { setsAt80: number; setsAt100: number } {
    const rows = this.database.prepare(
      "SELECT definition_id, current_value FROM achievement_progress WHERE user_id = ? AND definition_id IN ('set-completion-80/v1', 'set-completion-100/v1')"
    ).all(userId) as Array<{ definition_id: string; current_value: number }>;
    let setsAt80 = 0;
    let setsAt100 = 0;
    for (const row of rows) {
      if (row.definition_id === "set-completion-80/v1" && row.current_value >= 8000) setsAt80 = 1;
      if (row.definition_id === "set-completion-100/v1" && row.current_value >= 10_000) setsAt100 = 1;
    }
    return { setsAt80, setsAt100 };
  }

  /** 等级首次跨过阈值时发放一次性 GAME_CREDIT 奖励（correlationId 以等级去重），并写审计。 */
  private grantLevelUpReward(userId: string, targetLevel: number, now: string): void {
    const rewardAmount = resolveLevelUpReward(LEVEL_RULE_VERSION, targetLevel);
    if (rewardAmount === null) return;
    const account = this.database.prepare("SELECT id, available_amount FROM accounts WHERE user_id = ?").get(userId) as { id: string; available_amount: number } | undefined;
    if (!account) throw new Error("升级奖励账户不存在");
    const correlationId = `level-up:${userId}:${targetLevel}`;
    this.database.prepare(
      "UPDATE accounts SET total_amount = total_amount + ?, available_amount = available_amount + ?, updated_at = ? WHERE user_id = ?"
    ).run(rewardAmount, rewardAmount, now, userId);
    this.database.prepare(
      "INSERT INTO ledger_entries (id, account_id, direction, amount, balance_after, reason, correlation_id, occurred_at) VALUES (?, ?, 'credit', ?, ?, 'level_up_reward', ?, ?)"
    ).run(randomUUID(), account.id, rewardAmount, account.available_amount + rewardAmount, correlationId, now);
    this.database.prepare(
      "INSERT INTO audit_logs (id, actor_id, action, entity_type, entity_id, request_id, summary_json, occurred_at) VALUES (?, ?, 'level.up', 'player_growth', ?, ?, ?, ?)"
    ).run(randomUUID(), userId, userId, `growth:level-up:${userId}:${targetLevel}`, JSON.stringify({ targetLevel, rewardAmount }), now);
  }
}

/** 供结算点批量读取：等级能力为纯规则映射，level 1 默认与既有行为完全一致。 */
export function resolveCapabilitiesForLevel(level: number): LevelCapabilities {
  return resolveLevelCapabilities(level);
}

export type { GrowthCapabilitiesDto };
export { LEVEL_RULE_VERSION };
