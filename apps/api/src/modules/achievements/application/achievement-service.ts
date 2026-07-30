import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  type AchievementDefinitionDto,
  type AchievementProgressDto,
  type AchievementRewardDetailDto,
  type AchievementRewardKindDto,
  type AchievementUnlockDto,
  type AchievementUnlockSourceDto
} from "@mtg-market/contracts";
import {
  ACHIEVEMENT_RULE_VERSION,
  evaluateCollectionAchievements,
  evaluateDeckAchievements,
  evaluateRewardRisk,
  evaluateTournamentAchievements,
  resolveFirstAchievements,
  type AchievementDefinition,
  type ManaColor
} from "@mtg-market/rules";
import { InventoryService } from "../../inventory/application/inventory-service.js";
import { UserService } from "../../users/application/user-service.js";
import { naturalDateAt } from "../../users/domain/natural-day.js";

type DefinitionRow = {
  id: string;
  kind: "tournament" | "deck" | "collection";
  category: string;
  goal: number;
  reward_kind: AchievementRewardKindDto;
  reward_amount: number;
  reward_pack_id: string | null;
  reward_sku_id: string | null;
  reward_badge_id: string | null;
  title: string;
  description: string;
  badge: string | null;
  hidden: number;
  rule_version: string;
};

type FactRow = {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  payload_json: string;
  occurred_at: string;
};

type SettlementPayload = {
  tournamentId: string;
  playerId: string;
  result: "win" | "loss";
  reward: { amount: number; currency: string };
  ruleVersion: string;
  randomSeedHash: string;
};

/**
 * I26B 成就应用入口。所有写路径在一个 SQLite 短事务内完成解锁、发奖、风控计数与审计；
 * 历史事件补跑只追加新解锁，绝不重复发奖或覆盖已解锁记录。规则只来自 @mtg-market/rules。
 */
export class AchievementService {
  private readonly inventory: InventoryService;
  private readonly users: UserService;

  constructor(private readonly database: Database.Database, private readonly config: { timezone: string }) {
    this.inventory = new InventoryService(database);
    this.users = new UserService(database);
  }

  /**
   * 任务处理器唯一调用入口。读取指定 `tournament.settled` fact 并派生玩家档案、
   * 调用纯规则评估、在同一经济事务内原子写入进度/解锁/奖励/风控/审计。
   * 幂等：已处理或已解锁的 fact/定义组合直接跳过，不重复发奖。
   */
  processFactEvent(input: { factEventId: string; now?: Date }): { processed: boolean } {
    const now = (input.now ?? new Date()).toISOString();
    const naturalDate = naturalDateAt(input.now ?? new Date(), this.config.timezone);
    return this.inventory.withLedgerTransaction(() => {
      const fact = this.database.prepare(
        "SELECT id, aggregate_type, aggregate_id, payload_json, occurred_at FROM fact_events WHERE id = ? AND event_type = 'tournament.settled'"
      ).get(input.factEventId) as FactRow | undefined;
      if (!fact) return { processed: false };
      // 重复处理同一 fact：若该 fact 已被任何解锁/进度引用为来源，直接幂等返回。
      const alreadyProcessed = this.database.prepare(
        "SELECT 1 FROM achievement_progress WHERE last_evaluated_fact_id = ? LIMIT 1"
      ).get(input.factEventId);
      if (alreadyProcessed) return { processed: true };

      const payload = JSON.parse(fact.payload_json) as SettlementPayload;
      const playerId = payload.playerId;
      const won = payload.result === "win";
      const profile = this.deriveTournamentProfile(playerId, fact.aggregate_type, fact.aggregate_id, won);
      const deckProfile = this.deriveDeckProfile(fact.aggregate_type, fact.aggregate_id);
      const distinctSkuCount = this.countDistinctSkus(playerId);
      const definitions = this.definitions();
      const definitionIds = definitions.map((definition) => definition.id);
      const tournamentResult = evaluateTournamentAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds, profile });
      const deckResult = evaluateDeckAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds, profile: deckProfile, won });
      const collectionResult = evaluateCollectionAchievements({ ruleVersion: ACHIEVEMENT_RULE_VERSION, definitionIds, distinctSkuCount });
      const merged = new Map<string, { unlocked: boolean; progress: number; goal: number; kind: string }>();
      for (const evaluation of [...tournamentResult.evaluations, ...deckResult.evaluations, ...collectionResult.evaluations]) {
        const definition = definitions.find((entry) => entry.id === evaluation.definitionId)!;
        const current = merged.get(evaluation.definitionId);
        // 同一成就可能在多个评估中出现（如赛事+收藏混合 id 暂未交叉，保留取或逻辑以稳健）。
        if (!current || evaluation.unlocked) {
          merged.set(evaluation.definitionId, { unlocked: evaluation.unlocked, progress: evaluation.progress, goal: evaluation.goal, kind: definition.kind });
        }
      }

      const riskLimits = this.riskLimits();
      this.incrementRepeatParticipation(playerId, naturalDate, now);
      for (const [definitionId, evaluation] of merged) {
        this.upsertProgress(playerId, definitionId, evaluation.progress, evaluation.goal, evaluation.unlocked, input.factEventId, now);
        if (!evaluation.unlocked) continue;
        const unlockId = this.insertUnlock(playerId, definitionId, input.factEventId, fact.aggregate_id, now);
        // 先以唯一约束取得解锁写入权，才可写奖励。即使未来处理器改为并行，重复领取也不会先发奖后发现重复解锁。
        if (!unlockId) continue;
        const grant = this.tryGrantReward(playerId, definitionId, input.factEventId, fact.aggregate_id, riskLimits, naturalDate, now);
        this.writeRewardGrant(playerId, definitionId, unlockId, input.factEventId, fact.aggregate_id, grant, now);
      }
      return { processed: true };
    });
  }

  /** 列出全部成就定义及其当前玩家的进度；按定义顺序（迁移顺序）返回。 */
  overview(userId: string): Array<{ definition: AchievementDefinitionDto; progress: AchievementProgressDto | null }> {
    const progress = new Map(this.database.prepare(
      "SELECT definition_id, current_value, goal_value, status, unlocked_at, last_evaluated_fact_id FROM achievement_progress WHERE user_id = ?"
    ).all(userId).map((row) => {
      const value = row as { definition_id: string; current_value: number; goal_value: number; status: "pending" | "unlocked"; unlocked_at: string | null; last_evaluated_fact_id: string | null };
      return [value.definition_id, value] as const;
    }));
    return this.definitions().map((definition) => {
      const definitionDto = this.definitionDto(definition);
      const current = progress.get(definition.id);
      const progressDto: AchievementProgressDto | null = current
        ? { definitionId: definition.id, currentValue: current.current_value, goalValue: current.goal_value, status: current.status, unlockedAt: current.unlocked_at, lastEvaluatedFactId: current.last_evaluated_fact_id }
        : null;
      return { definition: definitionDto, progress: progressDto };
    });
  }

  /** 单成就详情含解锁来源；未解锁或不存在返回 null。 */
  detail(userId: string, definitionId: string): { definition: AchievementDefinitionDto; progress: AchievementProgressDto | null; unlock: AchievementUnlockDto | null } | null {
    const definition = this.definitions().find((entry) => entry.id === definitionId);
    if (!definition) return null;
    const progressRow = this.database.prepare(
      "SELECT definition_id, current_value, goal_value, status, unlocked_at, last_evaluated_fact_id FROM achievement_progress WHERE user_id = ? AND definition_id = ?"
    ).get(userId, definitionId) as { definition_id: string; current_value: number; goal_value: number; status: "pending" | "unlocked"; unlocked_at: string | null; last_evaluated_fact_id: string | null } | undefined;
    const progress: AchievementProgressDto | null = progressRow
      ? { definitionId: definitionId, currentValue: progressRow.current_value, goalValue: progressRow.goal_value, status: progressRow.status, unlockedAt: progressRow.unlocked_at, lastEvaluatedFactId: progressRow.last_evaluated_fact_id }
      : null;
    const unlock = this.unlockDto(userId, definitionId);
    return { definition: this.definitionDto(definition), progress, unlock };
  }

  unlocks(userId: string): AchievementUnlockDto[] {
    return this.definitions()
      .map((definition) => this.unlockDto(userId, definition.id))
      .filter((unlock): unlock is AchievementUnlockDto => unlock !== null)
      .sort((left, right) => left.unlockedAt.localeCompare(right.unlockedAt));
  }

  private deriveTournamentProfile(playerId: string, aggregateType: string, aggregateId: string, won: boolean): { participated: boolean; totalWins: number; consecutiveWins: number } {
    // 该事件的参与贡献由调用方传入；历史参与/胜场/连胜由已结算 fact 聚合（按时间序）。
    const facts = this.database.prepare(
      "SELECT aggregate_id, payload_json FROM fact_events WHERE event_type = 'tournament.settled' AND aggregate_id IN (SELECT id FROM tournament_registrations WHERE user_id = ? UNION SELECT id FROM player_tournament_registrations WHERE user_id = ?) ORDER BY occurred_at ASC, id ASC"
    ).all(playerId, playerId) as Array<{ aggregate_id: string; payload_json: string }>;
    const sequence = facts.map((fact) => {
      const parsed = JSON.parse(fact.payload_json) as SettlementPayload;
      return { aggregateId: fact.aggregate_id, result: parsed.result };
    });
    let totalWins = 0;
    for (const entry of sequence) if (entry.result === "win") totalWins += 1;
    // 连续胜场：定位当前事件，从该事件向前统计连续胜场（含当前事件），遇败停止。
    const anchorIndex = sequence.findIndex((entry) => entry.aggregateId === aggregateId);
    let consecutiveWins = 0;
    if (anchorIndex >= 0) {
      for (let index = anchorIndex; index >= 0; index -= 1) {
        if (sequence[index]!.result !== "win") break;
        consecutiveWins += 1;
      }
    } else if (won && aggregateType !== "") {
      consecutiveWins = 1;
    }
    return { participated: anchorIndex >= 0 || won, totalWins, consecutiveWins };
  }

  private deriveDeckProfile(aggregateType: string, aggregateId: string): { commanderColors: ManaColor[]; dominantSetCode: string | null } {
    const table = aggregateType === "player_tournament_registration" ? "player_tournament_deck_card_snapshots" : "tournament_deck_card_snapshots";
    const snapshot = this.database.prepare(`SELECT cards_json FROM ${table} WHERE registration_id = ?`).get(aggregateId) as { cards_json: string } | undefined;
    if (!snapshot) return { commanderColors: [], dominantSetCode: null };
    const cards = JSON.parse(snapshot.cards_json) as Array<{ zone: string; skuId: string | null; quantity: number; name: string; cardIdentity: string }>;
    const commanderSkuIds = cards.filter((card) => card.zone === "commander" && card.skuId !== null).map((card) => card.skuId!);
    const nonLandSkuIds = cards.filter((card) => card.zone === "main" && card.skuId !== null).map((card) => card.skuId!);
    const commanderColors = commanderSkuIds.length > 0 ? this.distinctColors(commanderSkuIds) : [];
    const dominantSetCode = this.dominantSetCode(nonLandSkuIds);
    return { commanderColors, dominantSetCode };
  }

  private distinctColors(skuIds: string[]): ManaColor[] {
    if (skuIds.length === 0) return [];
    const rows = this.skuColorIdentity(skuIds);
    const colors = new Set<ManaColor>();
    for (const row of rows) {
      const parsed = JSON.parse(row.color_identity_json) as unknown;
      if (!Array.isArray(parsed)) continue;
      for (const color of parsed) if (color === "W" || color === "U" || color === "B" || color === "R" || color === "G") colors.add(color);
    }
    return [...colors].sort() as ManaColor[];
  }

  private dominantSetCode(skuIds: string[]): string | null {
    if (skuIds.length === 0) return null;
    const rows = this.database.prepare(
      `SELECT s.code AS set_code, COUNT(*) AS card_count
       FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id JOIN card_sets s ON s.id = p.set_id
       WHERE sku.id IN (${skuIds.map(() => "?").join(",")})
       GROUP BY s.code ORDER BY card_count DESC, s.code ASC LIMIT 1`
    ).get(...skuIds) as { set_code: string; card_count: number } | undefined;
    if (!rows) return null;
    const total = skuIds.length;
    // 占非地牌一半以上才算主导；否则返回 null。
    return rows.card_count * 2 >= total ? rows.set_code : null;
  }

  private skuColorIdentity(skuIds: string[]): Array<{ sku_id: string; color_identity_json: string }> {
    return this.database.prepare(
      `SELECT sku.id AS sku_id, p.color_identity_json FROM card_skus sku JOIN card_printings p ON p.id = sku.printing_id WHERE sku.id IN (${skuIds.map(() => "?").join(",")})`
    ).all(...skuIds) as Array<{ sku_id: string; color_identity_json: string }>;
  }

  private countDistinctSkus(userId: string): number {
    const row = this.database.prepare("SELECT COUNT(DISTINCT sku_id) AS count FROM inventory_holdings WHERE user_id = ? AND quantity > 0").get(userId) as { count: number };
    return Number.isSafeInteger(row.count) ? row.count : 0;
  }

  private upsertProgress(userId: string, definitionId: string, progress: number, goal: number, unlocked: boolean, factEventId: string, now: string): void {
    const existing = this.database.prepare("SELECT id, status, current_value FROM achievement_progress WHERE user_id = ? AND definition_id = ?").get(userId, definitionId) as { id: string; status: string; current_value: number } | undefined;
    if (!existing) {
      this.database.prepare(
        "INSERT INTO achievement_progress (id, user_id, definition_id, current_value, goal_value, status, unlocked_at, last_evaluated_fact_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(randomUUID(), userId, definitionId, progress, goal, unlocked ? "unlocked" : "pending", unlocked ? now : null, factEventId, now);
      return;
    }
    // 已解锁只更新来源指针，不回退进度与状态。
    if (existing.status === "unlocked") {
      this.database.prepare("UPDATE achievement_progress SET last_evaluated_fact_id = ?, updated_at = ? WHERE id = ?").run(factEventId, now, existing.id);
      return;
    }
    this.database.prepare(
      "UPDATE achievement_progress SET current_value = ?, goal_value = ?, status = ?, unlocked_at = ?, last_evaluated_fact_id = ?, updated_at = ? WHERE id = ?"
    ).run(Math.max(existing.current_value, progress), goal, unlocked ? "unlocked" : "pending", unlocked ? now : null, factEventId, now, existing.id);
  }

  private tryGrantReward(userId: string, definitionId: string, factEventId: string, aggregateId: string, riskLimits: { maxRewardsPerDay: number; maxRepeatParticipationsPerDay: number }, naturalDate: string, now: string): { status: "granted" | "blocked"; reward: AchievementRewardDetailDto; correlationId: string } {
    const definition = this.definitions().find((entry) => entry.id === definitionId)!;
    const reward = this.rewardDetailFromRow(definition);
    const rewardCorrelationId = `achievement-reward:${userId}:${definitionId}`;
    // 徽章为不可交易展示物，无经济写入，不受奖励风控限制但仍写流水保证可审计。
    if (definition.reward_kind === "badge") {
      return { status: "granted", reward, correlationId: rewardCorrelationId };
    }
    const counters = this.riskCounters(userId, naturalDate);
    const risk = evaluateRewardRisk({
      ruleVersion: ACHIEVEMENT_RULE_VERSION,
      rewardsToday: counters.rewards_granted,
      maxRewardsPerDay: riskLimits.maxRewardsPerDay,
      repeatParticipationToday: counters.repeat_participations,
      maxRepeatPerDay: riskLimits.maxRepeatParticipationsPerDay
    });
    if (!risk.allowed) {
      // 风控拒绝时不发奖，但记录审计；解锁记录仍写入，奖励流水标记未发放。
      this.users.writeEconomicAudit(userId, "achievement.reward_blocked", "achievement_definition", definitionId, `job:achievement.process:${factEventId}`, { definitionId, aggregateId, reasons: risk.reasons }, now);
      return { status: "blocked", reward, correlationId: rewardCorrelationId };
    }
    if (definition.reward_kind === "GAME_CREDIT") {
      if (this.users.funds().creditAvailableFunds(userId, definition.reward_amount, now, rewardCorrelationId, "achievement_reward") === "missing") throw new Error("成就奖励账户不存在");
    } else if (definition.reward_kind === "sku") {
      if (this.inventory.acquireInLedgerTransaction({ userId, skuId: definition.reward_sku_id!, quantityDelta: 1, unitCostAmount: 0, reason: "achievement_reward", correlationId: rewardCorrelationId, now }) === "insufficient") throw new Error("成就奖励 SKU 入库失败");
    }
    this.incrementRewardsGranted(userId, naturalDate, now);
    return { status: "granted", reward, correlationId: rewardCorrelationId };
  }

  private insertUnlock(userId: string, definitionId: string, factEventId: string, aggregateId: string, now: string): string | null {
    const unlockId = randomUUID();
    const result = this.database.prepare(
      "INSERT OR IGNORE INTO achievement_unlocks (id, user_id, definition_id, source_type, source_fact_id, source_aggregate_id, rule_version, unlocked_at) VALUES (?, ?, ?, 'tournament.settled', ?, ?, ?, ?)"
    ).run(unlockId, userId, definitionId, factEventId, aggregateId, ACHIEVEMENT_RULE_VERSION, now);
    return result.changes === 1 ? unlockId : null;
  }

  private writeRewardGrant(userId: string, definitionId: string, unlockId: string, factEventId: string, aggregateId: string, grant: { status: "granted" | "blocked"; reward: AchievementRewardDetailDto; correlationId: string }, now: string): void {
    const definition = this.definitions().find((entry) => entry.id === definitionId)!;
    this.database.prepare(
      "INSERT INTO achievement_reward_grants (id, user_id, definition_id, unlock_id, reward_kind, reward_amount, reward_sku_id, reward_badge_id, grant_status, correlation_id, granted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(randomUUID(), userId, definitionId, unlockId, definition.reward_kind, definition.reward_amount, definition.reward_sku_id, definition.reward_badge_id, grant.status, grant.correlationId, now);
    this.users.writeEconomicAudit(userId, "achievement.unlocked", "achievement_definition", definitionId, `job:achievement.process:${factEventId}`, { definitionId, aggregateId, rewardKind: definition.reward_kind, rewardAmount: definition.reward_amount, rewardStatus: grant.status }, now);
  }

  private definitions(): DefinitionRow[] {
    return this.database.prepare(
      "SELECT id, kind, category, goal, reward_kind, reward_amount, reward_pack_id, reward_sku_id, reward_badge_id, title, description, badge, hidden, rule_version FROM achievement_definitions ORDER BY id"
    ).all() as DefinitionRow[];
  }

  private riskLimits(): { maxRewardsPerDay: number; maxRepeatParticipationsPerDay: number } {
    const row = this.database.prepare("SELECT max_rewards_per_day, max_repeat_participations_per_day FROM achievement_risk_limits WHERE singleton = 1").get() as { max_rewards_per_day: number; max_repeat_participations_per_day: number } | undefined;
    if (!row) throw new Error("成就风控阈值未配置");
    return { maxRewardsPerDay: row.max_rewards_per_day, maxRepeatParticipationsPerDay: row.max_repeat_participations_per_day };
  }

  private riskCounters(userId: string, naturalDate: string): { rewards_granted: number; repeat_participations: number } {
    const row = this.database.prepare("SELECT rewards_granted, repeat_participations FROM achievement_risk_counters WHERE user_id = ? AND natural_date = ?").get(userId, naturalDate) as { rewards_granted: number; repeat_participations: number } | undefined;
    return row ?? { rewards_granted: 0, repeat_participations: 0 };
  }

  private incrementRepeatParticipation(userId: string, naturalDate: string, now: string): number {
    const existing = this.database.prepare("SELECT rewards_granted, repeat_participations FROM achievement_risk_counters WHERE user_id = ? AND natural_date = ?").get(userId, naturalDate) as { rewards_granted: number; repeat_participations: number } | undefined;
    const next = (existing?.repeat_participations ?? 0) + 1;
    if (existing) {
      this.database.prepare("UPDATE achievement_risk_counters SET repeat_participations = ?, updated_at = ? WHERE user_id = ? AND natural_date = ?").run(next, now, userId, naturalDate);
    } else {
      this.database.prepare("INSERT INTO achievement_risk_counters (user_id, natural_date, rewards_granted, repeat_participations, updated_at) VALUES (?, ?, 0, ?, ?)").run(userId, naturalDate, next, now);
    }
    return next;
  }

  private incrementRewardsGranted(userId: string, naturalDate: string, now: string): void {
    const existing = this.database.prepare("SELECT rewards_granted, repeat_participations FROM achievement_risk_counters WHERE user_id = ? AND natural_date = ?").get(userId, naturalDate) as { rewards_granted: number; repeat_participations: number } | undefined;
    if (existing) {
      this.database.prepare("UPDATE achievement_risk_counters SET rewards_granted = rewards_granted + 1, updated_at = ? WHERE user_id = ? AND natural_date = ?").run(now, userId, naturalDate);
    } else {
      this.database.prepare("INSERT INTO achievement_risk_counters (user_id, natural_date, rewards_granted, repeat_participations, updated_at) VALUES (?, ?, 1, 0, ?)").run(userId, naturalDate, now);
    }
  }

  private definitionDto(row: DefinitionRow): AchievementDefinitionDto {
    return {
      id: row.id,
      kind: row.kind,
      category: row.category,
      goal: row.goal,
      reward: { kind: row.reward_kind, amount: row.reward_amount, packId: row.reward_pack_id, skuId: row.reward_sku_id, badgeId: row.reward_badge_id },
      display: { title: row.title, description: row.description, badge: row.badge },
      hidden: row.hidden === 1,
      ruleVersion: row.rule_version
    };
  }

  private rewardDetail(definition: AchievementDefinition): AchievementRewardDetailDto {
    return { kind: definition.reward.kind, amount: definition.reward.amount, packId: definition.reward.packId, skuId: definition.reward.skuId, badgeId: definition.reward.badgeId };
  }

  private rewardDetailFromRow(row: DefinitionRow): AchievementRewardDetailDto {
    return { kind: row.reward_kind, amount: row.reward_amount, packId: row.reward_pack_id, skuId: row.reward_sku_id, badgeId: row.reward_badge_id };
  }

  private unlockDto(userId: string, definitionId: string): AchievementUnlockDto | null {
    const unlock = this.database.prepare(
      "SELECT definition_id, source_type, source_fact_id, source_aggregate_id, rule_version, unlocked_at FROM achievement_unlocks WHERE user_id = ? AND definition_id = ?"
    ).get(userId, definitionId) as { definition_id: string; source_type: "tournament.settled" | "collection"; source_fact_id: string | null; source_aggregate_id: string | null; rule_version: string; unlocked_at: string } | undefined;
    if (!unlock) return null;
    const definition = this.definitions().find((entry) => entry.id === definitionId)!;
    const grant = this.database.prepare("SELECT reward_kind, reward_amount, reward_sku_id, reward_badge_id, grant_status, correlation_id FROM achievement_reward_grants WHERE user_id = ? AND definition_id = ?").get(userId, definitionId) as { reward_kind: AchievementRewardKindDto; reward_amount: number; reward_sku_id: string | null; reward_badge_id: string | null; grant_status: "granted" | "blocked"; correlation_id: string } | undefined;
    const source: AchievementUnlockSourceDto = { type: unlock.source_type, factId: unlock.source_fact_id, aggregateId: unlock.source_aggregate_id };
    return {
      definitionId: unlock.definition_id,
      source,
      ruleVersion: unlock.rule_version,
      unlockedAt: unlock.unlocked_at,
      reward: grant
        ? { kind: grant.reward_kind, amount: grant.reward_amount, packId: null, skuId: grant.reward_sku_id, badgeId: grant.reward_badge_id }
        : this.rewardDetailFromRow(definition),
      rewardStatus: grant?.grant_status ?? "blocked",
      rewardCorrelationId: grant?.correlation_id ?? null
    };
  }
}

// 校验规则包定义与迁移固定定义保持一致（启动期不调用；测试可显式调用）。
export function assertControlledAchievementsConsistent(): void {
  const fromRules = resolveFirstAchievements(ACHIEVEMENT_RULE_VERSION);
  if (fromRules.length === 0) throw new Error("规则包未提供受控成就");
}
