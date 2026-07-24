import type Database from "better-sqlite3";
import { withinTransaction } from "@mtg-market/database";
import type { InventoryHoldingDto } from "@mtg-market/contracts";
import { assertPositiveQuantity, type InventoryAdjustment, type InventoryLockTarget } from "../domain/inventory.js";
import { SqliteInventoryRepository, type InventoryFilters } from "../infrastructure/sqlite-inventory-repository.js";

/**
 * 经济调用的组合边界。开包、订单与比赛必须把账本/事实事件写入 callback，
 * 因而库存变化和相关货币流水由同一 SQLite 短事务提交或回滚。
 */
export type InventoryLedgerTransaction<T> = (inventory: SqliteInventoryRepository) => T;

export class InventoryService {
  private readonly inventory: SqliteInventoryRepository;
  constructor(private readonly database: Database.Database) { this.inventory = new SqliteInventoryRepository(database); }

  withLedgerTransaction<T>(operation: InventoryLedgerTransaction<T>): T { return withinTransaction(this.database, () => operation(this.inventory)); }
  acquire(input: InventoryAdjustment, withLedger?: () => void): InventoryHoldingDto | "insufficient" { assertPositiveQuantity(input.quantityDelta); return this.withLedgerTransaction((inventory) => { const result = inventory.adjust(input); if (result !== "insufficient") withLedger?.(); return result; }); }
  lock(input: { userId: string; skuId: string; quantity: number; target: InventoryLockTarget; correlationId: string; now: string }) { assertPositiveQuantity(input.quantity); return this.withLedgerTransaction((inventory) => inventory.lock(input.userId, input.skuId, input.quantity, input.target, input.correlationId, input.now)); }
  release(input: { userId: string; holdId: string; correlationId: string; now: string }) { return this.withLedgerTransaction((inventory) => inventory.release(input.userId, input.holdId, input.correlationId, input.now)); }
  capture(input: { userId: string; holdId: string; correlationId: string; now: string }) { return this.withLedgerTransaction((inventory) => inventory.capture(input.userId, input.holdId, input.correlationId, input.now)); }
  list(userId: string, filters: InventoryFilters) { return this.inventory.list(userId, filters); }
  holding(userId: string, skuId: string) { return this.inventory.findHolding(userId, skuId); }
  reconciliation(userId: string, skuId: string, cursor: string | undefined, limit: number) { return this.inventory.reconcile(userId, skuId, cursor, limit); }
}
