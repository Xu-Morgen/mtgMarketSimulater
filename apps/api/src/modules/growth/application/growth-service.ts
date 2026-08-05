import type Database from "better-sqlite3";
import { LevelService } from "./level-service.js";
import { TaskService, type GrowthFactRow } from "./task-service.js";

/**
 * I35B 留存/成长协作入口：在已结算事实写入方（pack/npc-trade/p2p/tournament）的同一
 * SQLite 短事务内同步推进任务实例进度与等级快照。外层经济事务已保证事实至多写入一次，
 * 任务实例以 (user_id, definition_id, period_key) 唯一约束、等级以持久化 level 收敛，
 * 因而同一事实的重复调用不会重复计数或重复发放升级奖励。
 */
export class GrowthService {
  private readonly tasks: TaskService;
  private readonly levels: LevelService;

  constructor(private readonly database: Database.Database, timezone: string) {
    this.tasks = new TaskService(database, timezone);
    this.levels = new LevelService(database);
  }

  /** 消费一条已写入的已结算事实（调用方必须已在该事务内写入 fact_events 行）。 */
  advanceFromFact(factId: string): void {
    const fact = this.database.prepare(
      "SELECT id, event_type, aggregate_type, aggregate_id, payload_json, occurred_at FROM fact_events WHERE id = ?"
    ).get(factId) as GrowthFactRow | undefined;
    if (!fact) throw new Error(`成长推进事实不存在：${factId}`);
    this.tasks.advanceFromFact(fact);
    for (const userId of this.tasks.affectedUserIds(fact)) {
      this.levels.syncForUser(userId, new Date(fact.occurred_at));
    }
  }

  /** 玩家当前等级能力（无成长记录视为等级 1）；供交易/开包结算点读取，只读无副作用。 */
  capabilities(userId: string) {
    return this.levels.capabilities(userId);
  }

  /** 仅为玩家刷新等级快照（不推进任务）；供测试与后续独立同步入口使用。 */
  syncLevelForUser(userId: string, now = new Date()): void {
    this.levels.syncForUser(userId, now);
  }
}
