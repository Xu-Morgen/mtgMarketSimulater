import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { InventoryEntryDto, InventoryHoldingDto, InventoryReconciliationDto, Page } from "@mtg-market/contracts";
import { nextAverageCost, type InventoryAdjustment, type InventoryLockTarget } from "../domain/inventory.js";

type HoldingRow = { id: string; user_id: string; sku_id: string; quantity: number; available_quantity: number; order_locked_quantity: number; tournament_locked_quantity: number; average_cost_amount: number; market_value_amount: number | null; market_value_captured_at: string | null; updated_at: string };
type HoldingWithCatalogRow = HoldingRow & { name: string; set_code: string; set_name: string; collector_number: string; finish: "nonfoil" | "foil" | "etched"; image_path: string | null; tradable: number };
type EntryRow = { id: string; user_id: string; sku_id: string; reason: string; quantity_delta: number; available_quantity_delta: number; order_locked_quantity_delta: number; tournament_locked_quantity_delta: number; quantity_after: number; average_cost_after: number; correlation_id: string; occurred_at: string };
type ActiveHoldRow = { id: string; holding_id: string; reason: "order" | "tournament"; quantity: number; user_id: string; sku_id: string; quantity_after: number; average_cost_amount: number };

export type InventoryFilters = { query?: string | undefined; setCode?: string | undefined; finish?: "nonfoil" | "foil" | "etched" | undefined; locked?: "any" | "locked" | "available" | undefined; sort: "updatedAt" | "name" | "quantity" | "availableQuantity"; direction: "asc" | "desc"; cursor?: string | undefined; limit: number };

function holdingDto(row: HoldingWithCatalogRow): InventoryHoldingDto {
  return { skuId: row.sku_id, quantity: row.quantity, availableQuantity: row.available_quantity, orderLockedQuantity: row.order_locked_quantity, tournamentLockedQuantity: row.tournament_locked_quantity, averageCost: { amount: row.average_cost_amount, currency: "GAME_CREDIT" }, marketValue: row.market_value_amount === null ? null : { amount: row.market_value_amount, currency: "GAME_CREDIT" }, updatedAt: row.updated_at, marketValueUnavailableReason: row.market_value_amount === null ? "no_snapshot" : null, sku: { id: row.sku_id, name: row.name, setCode: row.set_code, setName: row.set_name, collectorNumber: row.collector_number, finish: row.finish, imagePath: row.image_path, tradable: row.tradable === 1 } };
}
function entryDto(row: EntryRow): InventoryEntryDto {
  return { id: row.id, userId: row.user_id, skuId: row.sku_id, reason: row.reason, quantityDelta: row.quantity_delta, availableQuantityDelta: row.available_quantity_delta, orderLockedQuantityDelta: row.order_locked_quantity_delta, tournamentLockedQuantityDelta: row.tournament_locked_quantity_delta, quantityAfter: row.quantity_after, averageCostAfter: { amount: row.average_cost_after, currency: "GAME_CREDIT" }, correlationId: row.correlation_id, occurredAt: row.occurred_at };
}

/** SQLite 是库存数量、锁定和追加式库存流水的唯一存储；所有写入由 application 短事务编排。 */
export class SqliteInventoryRepository {
  constructor(private readonly database: Database.Database) {}

  adjust(input: InventoryAdjustment): InventoryHoldingDto | "insufficient" {
    const current = this.holding(input.userId, input.skuId);
    if (!current && input.quantityDelta < 0) return "insufficient";
    const now = input.now;
    const row = current ?? this.createHolding(input.userId, input.skuId, now);
    if (row.available_quantity + input.quantityDelta < 0) return "insufficient";
    const quantity = row.quantity + input.quantityDelta;
    if (quantity < 0) return "insufficient";
    const averageCost = nextAverageCost(row.quantity, row.average_cost_amount, input.quantityDelta, input.unitCostAmount);
    this.database.prepare("UPDATE inventory_holdings SET quantity = ?, available_quantity = ?, average_cost_amount = ?, updated_at = ? WHERE id = ?").run(quantity, row.available_quantity + input.quantityDelta, averageCost, now, row.id);
    this.writeEntry(row.id, input.reason, input.quantityDelta, input.quantityDelta, 0, 0, quantity, averageCost, input.correlationId, now);
    return this.findHolding(input.userId, input.skuId)!;
  }

  lock(userId: string, skuId: string, quantity: number, target: InventoryLockTarget, correlationId: string, now: string): { holdId: string; holding: InventoryHoldingDto } | "insufficient" | "already-locked" {
    const row = this.holding(userId, skuId);
    if (!row || row.available_quantity < quantity) return "insufficient";
    const existing = this.database.prepare("SELECT id, status FROM inventory_holds WHERE holding_id = ? AND reason = ? AND entity_type = ? AND entity_id = ?").get(row.id, target.reason, target.entityType, target.entityId) as { id: string; status: string } | undefined;
    if (existing) return "already-locked";
    const lockedColumn = target.reason === "order" ? "order_locked_quantity" : "tournament_locked_quantity";
    const changed = this.database.prepare(`UPDATE inventory_holdings SET available_quantity = available_quantity - ?, ${lockedColumn} = ${lockedColumn} + ?, updated_at = ? WHERE id = ? AND available_quantity >= ?`).run(quantity, quantity, now, row.id, quantity);
    if (changed.changes !== 1) return "insufficient";
    const holdId = randomUUID();
    this.database.prepare("INSERT INTO inventory_holds (id, holding_id, reason, quantity, entity_type, entity_id, status, created_at, released_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)").run(holdId, row.id, target.reason, quantity, target.entityType, target.entityId, now);
    this.writeEntry(row.id, `${target.reason}_locked`, 0, -quantity, target.reason === "order" ? quantity : 0, target.reason === "tournament" ? quantity : 0, row.quantity, row.average_cost_amount, correlationId, now);
    return { holdId, holding: this.findHolding(userId, skuId)! };
  }

  release(userId: string, holdId: string, correlationId: string, now: string): InventoryHoldingDto | "not-active" {
    const hold = this.activeHold(userId, holdId); if (!hold) return "not-active";
    const changed = this.database.prepare("UPDATE inventory_holds SET status = 'released', released_at = ? WHERE id = ? AND status = 'active'").run(now, hold.id);
    if (changed.changes !== 1) return "not-active";
    const lockedColumn = hold.reason === "order" ? "order_locked_quantity" : "tournament_locked_quantity";
    this.database.prepare(`UPDATE inventory_holdings SET available_quantity = available_quantity + ?, ${lockedColumn} = ${lockedColumn} - ?, updated_at = ? WHERE id = ? AND ${lockedColumn} >= ?`).run(hold.quantity, hold.quantity, now, hold.holding_id, hold.quantity);
    this.writeEntry(hold.holding_id, `${hold.reason}_released`, 0, hold.quantity, hold.reason === "order" ? -hold.quantity : 0, hold.reason === "tournament" ? -hold.quantity : 0, hold.quantity_after, hold.average_cost_amount, correlationId, now);
    return this.findHolding(userId, hold.sku_id)!;
  }

  capture(userId: string, holdId: string, correlationId: string, now: string): InventoryHoldingDto | "not-active" {
    const hold = this.activeHold(userId, holdId); if (!hold) return "not-active";
    const changed = this.database.prepare("UPDATE inventory_holds SET status = 'captured', released_at = ? WHERE id = ? AND status = 'active'").run(now, hold.id);
    if (changed.changes !== 1) return "not-active";
    const lockedColumn = hold.reason === "order" ? "order_locked_quantity" : "tournament_locked_quantity";
    const nextQuantity = hold.quantity_after - hold.quantity; const nextAverageCost = nextQuantity === 0 ? 0 : hold.average_cost_amount;
    const updated = this.database.prepare(`UPDATE inventory_holdings SET quantity = quantity - ?, ${lockedColumn} = ${lockedColumn} - ?, average_cost_amount = ?, updated_at = ? WHERE id = ? AND quantity >= ? AND ${lockedColumn} >= ?`).run(hold.quantity, hold.quantity, nextAverageCost, now, hold.holding_id, hold.quantity, hold.quantity);
    if (updated.changes !== 1) throw new Error("库存锁定状态损坏");
    this.writeEntry(hold.holding_id, `${hold.reason}_captured`, -hold.quantity, 0, hold.reason === "order" ? -hold.quantity : 0, hold.reason === "tournament" ? -hold.quantity : 0, nextQuantity, nextAverageCost, correlationId, now);
    return this.findHolding(userId, hold.sku_id)!;
  }

  list(userId: string, filters: InventoryFilters): Page<InventoryHoldingDto> {
    const where = ["h.user_id = ?"]; const values: unknown[] = [userId];
    if (filters.query) { where.push("lower(p.name) LIKE lower(?)"); values.push(`%${filters.query}%`); }
    if (filters.setCode) { where.push("s.code = ?"); values.push(filters.setCode); }
    if (filters.finish) { where.push("sku.finish = ?"); values.push(filters.finish); }
    if (filters.locked === "locked") where.push("h.order_locked_quantity + h.tournament_locked_quantity > 0");
    if (filters.locked === "available") where.push("h.available_quantity > 0");
    const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("库存分页游标无效");
    const clause = `WHERE ${where.join(" AND ")}`; const sort = { updatedAt: "h.updated_at", name: "p.name COLLATE NOCASE", quantity: "h.quantity", availableQuantity: "h.available_quantity" }[filters.sort];
    const total = (this.database.prepare(`SELECT COUNT(*) AS count FROM inventory_holdings h JOIN card_skus sku ON sku.id = h.sku_id JOIN card_printings p ON p.id = sku.printing_id JOIN card_sets s ON s.id = p.set_id ${clause}`).get(...values) as { count: number }).count;
    const rows = this.database.prepare(`${this.selectHoldingSql()} ${clause} ORDER BY ${sort} ${filters.direction.toUpperCase()}, h.id ASC LIMIT ? OFFSET ?`).all(...values, filters.limit + 1, offset) as HoldingWithCatalogRow[];
    const hasMore = rows.length > filters.limit; return { items: rows.slice(0, filters.limit).map(holdingDto), page: { total, hasMore, nextCursor: hasMore ? String(offset + filters.limit) : null } };
  }

  findHolding(userId: string, skuId: string): InventoryHoldingDto | null { const row = this.database.prepare(`${this.selectHoldingSql()} WHERE h.user_id = ? AND h.sku_id = ?`).get(userId, skuId) as HoldingWithCatalogRow | undefined; return row ? holdingDto(row) : null; }
  reconcile(userId: string, skuId: string, cursor: string | undefined, limit: number): InventoryReconciliationDto | null {
    const holding = this.holding(userId, skuId); if (!holding) return null; const offset = cursor ? Number.parseInt(cursor, 10) : 0;
    const rows = this.database.prepare(`SELECT e.id, h.user_id, h.sku_id, e.reason, e.quantity_delta, e.available_quantity_delta, e.order_locked_quantity_delta, e.tournament_locked_quantity_delta, e.quantity_after, e.average_cost_after, e.correlation_id, e.occurred_at FROM inventory_entries e JOIN inventory_holdings h ON h.id = e.holding_id WHERE e.holding_id = ? ORDER BY e.occurred_at DESC, e.id DESC LIMIT ? OFFSET ?`).all(holding.id, limit + 1, offset) as EntryRow[];
    const hasMore = rows.length > limit; return { skuId, quantity: holding.quantity, availableQuantity: holding.available_quantity, orderLockedQuantity: holding.order_locked_quantity, tournamentLockedQuantity: holding.tournament_locked_quantity, reconciled: holding.quantity === holding.available_quantity + holding.order_locked_quantity + holding.tournament_locked_quantity, entries: { items: rows.slice(0, limit).map(entryDto), page: { hasMore, nextCursor: hasMore ? String(offset + limit) : null } } };
  }

  private holding(userId: string, skuId: string): HoldingRow | undefined { return this.database.prepare("SELECT id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, market_value_captured_at, updated_at FROM inventory_holdings WHERE user_id = ? AND sku_id = ?").get(userId, skuId) as HoldingRow | undefined; }
  private createHolding(userId: string, skuId: string, now: string): HoldingRow { const id = randomUUID(); this.database.prepare("INSERT INTO inventory_holdings (id, user_id, sku_id, quantity, available_quantity, order_locked_quantity, tournament_locked_quantity, average_cost_amount, market_value_amount, market_value_captured_at, updated_at) VALUES (?, ?, ?, 0, 0, 0, 0, 0, NULL, NULL, ?)").run(id, userId, skuId, now); return this.holding(userId, skuId)!; }
  private activeHold(userId: string, holdId: string): ActiveHoldRow | undefined { return this.database.prepare("SELECT ih.id, ih.holding_id, ih.reason, ih.quantity, h.user_id, h.sku_id, h.quantity AS quantity_after, h.average_cost_amount FROM inventory_holds ih JOIN inventory_holdings h ON h.id = ih.holding_id WHERE ih.id = ? AND h.user_id = ? AND ih.status = 'active'").get(holdId, userId) as ActiveHoldRow | undefined; }
  private writeEntry(holdingId: string, reason: string, quantityDelta: number, availableDelta: number, orderDelta: number, tournamentDelta: number, quantityAfter: number, averageCostAfter: number, correlationId: string, now: string): void { this.database.prepare("INSERT INTO inventory_entries (id, holding_id, reason, quantity_delta, available_quantity_delta, order_locked_quantity_delta, tournament_locked_quantity_delta, quantity_after, average_cost_after, correlation_id, occurred_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), holdingId, reason, quantityDelta, availableDelta, orderDelta, tournamentDelta, quantityAfter, averageCostAfter, correlationId, now); }
  private selectHoldingSql(): string { return "SELECT h.id, h.user_id, h.sku_id, h.quantity, h.available_quantity, h.order_locked_quantity, h.tournament_locked_quantity, h.average_cost_amount, h.market_value_amount, h.market_value_captured_at, h.updated_at, p.name, s.code AS set_code, s.name AS set_name, p.collector_number, sku.finish, image.cache_path AS image_path, sku.tradable FROM inventory_holdings h JOIN card_skus sku ON sku.id = h.sku_id JOIN card_printings p ON p.id = sku.printing_id JOIN card_sets s ON s.id = p.set_id LEFT JOIN card_image_cache image ON image.printing_id = p.id"; }
}
