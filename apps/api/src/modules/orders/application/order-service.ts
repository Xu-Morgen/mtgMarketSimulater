import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  calculateOrderFees,
  isWithinOrderLimitBand,
  ORDER_PREVIEW_VERSION,
  ORDER_RULE_VERSION,
  resolveOrderLimitBand,
  validateOrderCancellation
} from "@mtg-market/rules";
import {
  canonicalizeRequest,
  type ApiErrorCode,
  type ApiResponse,
  type BilateralOrderBookDto,
  type BilateralOrderBookLevelDto,
  type BilateralOrderDto,
  type BilateralOrderPreviewDto,
  type FeeDto,
  type OrderSide,
  type OrderStatus,
  type Page
} from "@mtg-market/contracts";
import { InventoryService } from "../../inventory/application/inventory-service.js";
import { MarketService } from "../../market/application/market-service.js";
import { UserService } from "../../users/application/user-service.js";
import { success, failure } from "../../../shared/http/api-response.js";
import { ORDER_HOLD_ENTITY_TYPE, assertPositiveQuantity } from "../domain/order.js";

type LimitsRow = {
  max_quantity_per_order: number;
  max_quantity_per_user_sku_day: number;
  limit_price_band_bps: number;
  order_fee_bps: number;
  fulfillment_deposit_bps: number;
  ttl_seconds: number;
};
type QuoteRow = {
  id: string;
  sku_id: string;
  rule_version: string;
  market_price_amount: number;
  valid_until: string;
  tradable: number;
};
type OrderRow = {
  id: string;
  user_id: string;
  sku_id: string;
  side: OrderSide;
  status: string;
  original_quantity: number;
  remaining_quantity: number;
  limit_price_amount: number;
  unit_fee_amount: number;
  unit_fulfillment_deposit_amount: number;
  reserved_funds_amount: number;
  reserved_funds_hold_id: string | null;
  inventory_hold_id: string | null;
  quote_id: string;
  quote_version: string;
  preview_version: string;
  expires_at: string;
  cancelled_at: string | null;
  version: number;
  settlement_date: string;
  created_at: string;
  updated_at: string;
};
type IdempotencyRow = { request_fingerprint: string; status: string; response_status: number | null; response_json: string | null };

type OrderResponse = { order: BilateralOrderDto };

export type OrderPreviewResult = BilateralOrderPreviewDto | "quote-unavailable" | "quote-stale" | "insufficient-quantity";

export type OrderCommandResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<OrderResponse> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<OrderResponse> }
  | { state: "conflict" }
  | { state: "in-progress" };

/**
 * I18B 的双边委托用例。Order 模块只经 Market/User/Inventory 的 application 接口协作；
 * 委托、资金/库存预占、审计和幂等结果共享一个 SQLite 短事务。撮合、模拟履约与
 * p2p.trade.settled 事实事件延后至 I19B/I20B。
 */
export class OrderService {
  private readonly inventory: InventoryService;
  private readonly users: UserService;
  private readonly market: MarketService;

  constructor(private readonly database: Database.Database) {
    this.inventory = new InventoryService(database);
    this.users = new UserService(database);
    this.market = new MarketService(database);
  }

  preview(userId: string, skuId: string, side: OrderSide, quantity: number, now = new Date()): OrderPreviewResult {
    assertPositiveQuantity(quantity);
    const quote = this.loadQuote(skuId);
    if (!quote || quote.tradable !== 1) return "quote-unavailable";
    const nowIso = now.toISOString();
    if (quote.valid_until <= nowIso) return "quote-stale";
    return this.buildPreview(userId, side, quantity, quote, nowIso);
  }

  create(input: {
    userId: string;
    skuId: string;
    side: OrderSide;
    quantity: number;
    limitPrice: number;
    quoteId: string;
    quoteVersion: string;
    previewVersion: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): OrderCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.idempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.idempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }

      const quote = this.loadQuote(input.skuId, input.quoteId);
      if (!quote || quote.tradable !== 1) return this.fail(input, now, 404, "PRICE_UNAVAILABLE", "该 SKU 暂无可结算报价");
      if (quote.rule_version !== input.quoteVersion || quote.valid_until <= now)
        return this.fail(input, now, 409, "VERSION_STALE", "报价已过期或版本已更新，请重新预览");
      if (quote.id !== input.quoteId)
        return this.fail(input, now, 409, "VERSION_STALE", "报价快照已更新，请重新预览");

      const preview = this.buildPreview(input.userId, input.side, input.quantity, quote, now);
      if (preview.previewVersion !== input.previewVersion)
        return this.fail(input, now, 409, "VERSION_STALE", "预览已过期或报价/限价已变化，请重新预览");
      if (!preview.canPlace) {
        if (preview.unavailableReason === "archive_required")
          return this.fail(input, now, 409, "RESOURCE_CONFLICT", "请先创建游戏存档");
        if (preview.unavailableReason === "insufficient_balance")
          return this.fail(input, now, 409, "INSUFFICIENT_BALANCE", "可用余额不足，无法完成买单预占");
        if (preview.unavailableReason === "insufficient_inventory")
          return this.fail(input, now, 409, "INSUFFICIENT_INVENTORY", "可用库存不足，锁定库存不可挂卖单");
        return this.fail(input, now, 409, "RULE_VIOLATION", "本次委托超过服务器交易量限制");
      }
      if (!isWithinOrderLimitBand(input.limitPrice, resolveOrderLimitBand({ marketPrice: quote.market_price_amount, minimumPrice: this.minimumPrice(), limitPriceBandBasisPoints: this.limits().limit_price_band_bps })))
        return this.fail(input, now, 409, "RULE_VIOLATION", "限价超出有效报价范围，请重新预览");

      const fees = calculateOrderFees({
        side: input.side,
        quantity: input.quantity,
        limitPrice: input.limitPrice,
        marketPrice: quote.market_price_amount,
        orderFeeBasisPoints: this.limits().order_fee_bps,
        fulfillmentDepositBasisPoints: this.limits().fulfillment_deposit_bps,
        minimumPrice: this.minimumPrice()
      });

      const orderId = randomUUID();
      const expiresAt = new Date(new Date(now).getTime() + this.limits().ttl_seconds * 1_000).toISOString();

      let reservedFundsHoldId: string | null = null;
      let inventoryHoldId: string | null = null;

      if (input.side === "buy") {
        const reserved = this.users.reserveOrderFunds(input.userId, fees.reservedFunds, { entityType: ORDER_HOLD_ENTITY_TYPE, entityId: orderId, reason: "order_buy" }, now);
        if (reserved === "insufficient") return this.fail(input, now, 409, "INSUFFICIENT_BALANCE", "可用余额不足，无法完成买单预占");
        reservedFundsHoldId = reserved.holdId;
      } else {
        const locked = this.inventory.lock({
          userId: input.userId,
          skuId: input.skuId,
          quantity: input.quantity,
          target: { reason: "order", entityType: ORDER_HOLD_ENTITY_TYPE, entityId: orderId },
          correlationId: orderId,
          now
        });
        if (locked === "insufficient") return this.fail(input, now, 409, "INSUFFICIENT_INVENTORY", "可用库存不足，锁定库存不可挂卖单");
        if (locked === "already-locked") return this.fail(input, now, 409, "INVENTORY_LOCKED", "该库存已被同一委托锁定");
        inventoryHoldId = locked.holdId;
        const deposit = this.users.reserveOrderFunds(input.userId, fees.fulfillmentDeposit, { entityType: ORDER_HOLD_ENTITY_TYPE, entityId: orderId, reason: "order_fulfillment_deposit" }, now);
        if (deposit === "insufficient") {
          throw new Error("卖单保证金预占失败：库存已锁定但资金不足，事务将回滚");
        }
        reservedFundsHoldId = deposit.holdId;
      }

      const settlementDate = now.slice(0, 10);
      const reservedFundsAmount = input.side === "buy" ? fees.reservedFunds : fees.fulfillmentDeposit;
      this.database.prepare(
        `INSERT INTO bilateral_orders (id, user_id, sku_id, side, status, original_quantity, remaining_quantity, limit_price_amount, unit_fee_amount, unit_fulfillment_deposit_amount, reserved_funds_amount, reserved_funds_hold_id, inventory_hold_id, quote_id, quote_version, preview_version, expires_at, cancelled_at, version, settlement_date, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`
      ).run(
        orderId, input.userId, input.skuId, input.side, input.quantity, input.quantity,
        input.limitPrice, fees.unitFee, fees.unitFulfillmentDeposit, reservedFundsAmount,
        reservedFundsHoldId, inventoryHoldId, quote.id, quote.rule_version, input.previewVersion,
        expiresAt, settlementDate, now, now
      );

      const order = this.toOrderDto(this.findOrderRow(orderId)!);
      this.users.writeEconomicAudit(input.userId, "bilateral_order.created", "bilateral_order", orderId, input.requestId, {
        side: input.side, skuId: input.skuId, quantity: input.quantity, limitPrice: input.limitPrice,
        quoteId: quote.id, quoteVersion: quote.rule_version, previewVersion: input.previewVersion,
        reservedFunds: reservedFundsAmount, reservedFundsHoldId, inventoryHoldId, expiresAt
      }, now);
      const response = success(input.requestId, { order });
      this.completeIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  cancel(input: { userId: string; orderId: string; idempotencyKey: string; requestFingerprint: string; requestId: string; now?: Date }): OrderCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.idempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.idempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }

      const row = this.findOrderRow(input.orderId);
      if (!row || row.user_id !== input.userId)
        return this.fail(input, now, 404, "RESOURCE_NOT_FOUND", "未找到该委托");
      const cancellation = validateOrderCancellation(row.status);
      if (!cancellation.ok)
        return this.fail(input, now, 409, "RESOURCE_CONFLICT", `当前状态 ${row.status} 不可撤单`);

      const advanced = this.database.prepare(
        "UPDATE bilateral_orders SET status = 'cancelled', cancelled_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND user_id = ? AND version = ?"
      ).run(now, now, input.orderId, input.userId, row.version);
      if (advanced.changes !== 1)
        return this.fail(input, now, 409, "RESOURCE_CONFLICT", "委托状态已变化，请刷新后重试");

      if (row.reserved_funds_hold_id) {
        const released = this.users.releaseOrderFunds(input.userId, row.reserved_funds_hold_id, now);
        if (released === "not-active") throw new Error(`撤单资金释放失败：hold ${row.reserved_funds_hold_id} 非活跃，事务回滚`);
      }
      if (row.inventory_hold_id) {
        const released = this.inventory.release({ userId: input.userId, holdId: row.inventory_hold_id, correlationId: input.orderId, now });
        if (released === "not-active") throw new Error(`撤单库存释放失败：hold ${row.inventory_hold_id} 非活跃，事务回滚`);
      }

      const order = this.toOrderDto(this.findOrderRow(input.orderId)!);
      this.users.writeEconomicAudit(input.userId, "bilateral_order.cancelled", "bilateral_order", input.orderId, input.requestId, {
        side: row.side, skuId: row.sku_id, remainingQuantity: row.remaining_quantity,
        releasedFunds: row.reserved_funds_amount, releasedInventoryQuantity: row.side === "sell" ? row.remaining_quantity : 0
      }, now);
      const response = success(input.requestId, { order });
      this.completeIdempotency(input.userId, input.idempotencyKey, 200, response, now);
      return { state: "completed", statusCode: 200, response };
    });
  }

  find(userId: string, orderId: string): BilateralOrderDto | null {
    const row = this.findOrderRow(orderId);
    if (!row || row.user_id !== userId) return null;
    return this.toOrderDto(row);
  }

  list(userId: string, filters: { status?: OrderStatus[]; side?: OrderSide; cursor?: string; limit: number }): Page<BilateralOrderDto> {
    const where = ["user_id = ?"]; const values: unknown[] = [userId];
    if (filters.side) { where.push("side = ?"); values.push(filters.side); }
    if (filters.status && filters.status.length) { where.push(`status IN (${filters.status.map(() => "?").join(",")})`); values.push(...filters.status); }
    const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("委托分页游标无效");
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = (this.database.prepare(`SELECT COUNT(*) AS count FROM bilateral_orders ${clause}`).get(...values) as { count: number }).count;
    const rows = this.database.prepare(
      `${this.selectOrderSql()} ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`
    ).all(...values, filters.limit + 1, offset) as OrderRow[];
    const hasMore = rows.length > filters.limit;
    return { items: rows.slice(0, filters.limit).map((row) => this.toOrderDto(row)), page: { total, hasMore, nextCursor: hasMore ? String(offset + filters.limit) : null } };
  }

  book(skuId: string, now = new Date().toISOString()): BilateralOrderBookDto {
    const aggregate = (side: OrderSide): BilateralOrderBookLevelDto[] => {
      const rows = this.database.prepare(
        `SELECT limit_price_amount, SUM(remaining_quantity) AS qty, COUNT(*) AS cnt FROM bilateral_orders
         WHERE sku_id = ? AND side = ? AND status IN ('open', 'partially_filled') AND expires_at > ?
         GROUP BY limit_price_amount ORDER BY ${side === "buy" ? "limit_price_amount DESC" : "limit_price_amount ASC"}, limit_price_amount`
      ).all(skuId, side, now) as Array<{ limit_price_amount: number; qty: number; cnt: number }>;
      return rows.map((row) => ({ limitPrice: money(row.limit_price_amount), remainingQuantity: row.qty, orderCount: row.cnt }));
    };
    return { skuId, bids: aggregate("buy"), asks: aggregate("sell"), capturedAt: now };
  }

  private buildPreview(userId: string, side: OrderSide, quantity: number, quote: QuoteRow, now: string): BilateralOrderPreviewDto {
    const limits = this.limits();
    const minimum = this.minimumPrice();
    const band = resolveOrderLimitBand({ marketPrice: quote.market_price_amount, minimumPrice: minimum, limitPriceBandBasisPoints: limits.limit_price_band_bps });
    const day = now.slice(0, 10);
    const used = (this.database.prepare(
      "SELECT COALESCE(SUM(original_quantity), 0) AS quantity FROM bilateral_orders WHERE user_id = ? AND sku_id = ? AND side = ? AND settlement_date = ?"
    ).get(userId, quote.sku_id, side, day) as { quantity: number }).quantity;
    const remaining = Math.max(0, limits.max_quantity_per_user_sku_day - used);
    const fee = calculateOrderFees({
      side, quantity, limitPrice: band.marketPrice, marketPrice: quote.market_price_amount,
      orderFeeBasisPoints: limits.order_fee_bps, fulfillmentDepositBasisPoints: limits.fulfillment_deposit_bps, minimumPrice: minimum
    });
    const balance = this.users.balance(userId);
    const fees: FeeDto[] = [
      { kind: "order_fee", amount: money(fee.orderFee) },
      { kind: "fulfillment_deposit", amount: money(fee.fulfillmentDeposit) }
    ];
    const previewVersion = previewVersionHash(quote.id, quote.rule_version, side, quantity, band.min, band.max, fee.reservedFunds);
    const unavailableReason = !balance
      ? "archive_required"
      : quantity > limits.max_quantity_per_order || quantity > remaining
        ? "trade_limit_reached"
        : side === "buy"
          ? balance.available.amount < fee.reservedFunds ? "insufficient_balance" : null
          : (this.inventory.holding(userId, quote.sku_id)?.availableQuantity ?? 0) < quantity ? "insufficient_inventory" : null;
    const preview: BilateralOrderPreviewDto = {
      skuId: quote.sku_id,
      side,
      quantity,
      quoteId: quote.id,
      quoteVersion: quote.rule_version,
      fees,
      reservedFunds: money(side === "buy" ? fee.reservedFunds : fee.fulfillmentDeposit),
      estimatedAmount: money(fee.estimatedAmount),
      limitBand: { marketPrice: money(band.marketPrice), min: money(band.min), max: money(band.max), limitPriceBandBasisPoints: limits.limit_price_band_bps },
      previewVersion,
      validUntil: quote.valid_until,
      limit: { maxQuantityPerOrder: limits.max_quantity_per_order, maxQuantityPerUserSkuDay: limits.max_quantity_per_user_sku_day, remainingQuantityToday: remaining, ttlSeconds: limits.ttl_seconds },
      canPlace: unavailableReason === null,
      unavailableReason
    };
    if (side === "sell") preview.availableQuantity = this.inventory.holding(userId, quote.sku_id)?.availableQuantity ?? 0;
    return preview;
  }

  private loadQuote(skuId: string, quoteId?: string): QuoteRow | undefined {
    return this.database.prepare(
      `SELECT q.id, q.sku_id, q.rule_version, q.market_price_amount, q.valid_until, sku.tradable
       FROM market_quotes q JOIN card_skus sku ON sku.id = q.sku_id
       WHERE q.sku_id = ? ${quoteId ? "AND q.id = ?" : ""}
       ORDER BY q.calculated_at DESC, q.rowid DESC LIMIT 1`
    ).get(...(quoteId ? [skuId, quoteId] : [skuId])) as QuoteRow | undefined;
  }

  private limits(): LimitsRow {
    const limits = this.database.prepare(
      "SELECT max_quantity_per_order, max_quantity_per_user_sku_day, limit_price_band_bps, order_fee_bps, fulfillment_deposit_bps, ttl_seconds FROM bilateral_order_limits WHERE singleton = 1"
    ).get() as LimitsRow | undefined;
    if (!limits) throw new Error("双边委托额度未初始化");
    return limits;
  }

  private minimumPrice(): number {
    const row = this.database.prepare("SELECT minimum_price FROM market_parameters WHERE singleton = 1").get() as { minimum_price: number } | undefined;
    if (!row) throw new Error("市场参数未初始化");
    return row.minimum_price;
  }

  private selectOrderSql(): string {
    return "SELECT id, user_id, sku_id, side, status, original_quantity, remaining_quantity, limit_price_amount, unit_fee_amount, unit_fulfillment_deposit_amount, reserved_funds_amount, reserved_funds_hold_id, inventory_hold_id, quote_id, quote_version, preview_version, expires_at, cancelled_at, version, settlement_date, created_at, updated_at FROM bilateral_orders";
  }

  private findOrderRow(orderId: string): OrderRow | undefined {
    return this.database.prepare(`${this.selectOrderSql()} WHERE id = ?`).get(orderId) as OrderRow | undefined;
  }

  private toOrderDto(row: OrderRow): BilateralOrderDto {
    const fees: FeeDto[] = [
      { kind: "order_fee", amount: money(row.unit_fee_amount * row.remaining_quantity) },
      { kind: "fulfillment_deposit", amount: money(row.unit_fulfillment_deposit_amount * row.remaining_quantity) }
    ];
    return {
      id: row.id,
      userId: row.user_id,
      skuId: row.sku_id,
      side: row.side,
      status: row.status as BilateralOrderDto["status"],
      originalQuantity: row.original_quantity,
      remainingQuantity: row.remaining_quantity,
      limitPrice: money(row.limit_price_amount),
      fees,
      reservedFunds: money(row.reserved_funds_amount),
      reservedInventoryQuantity: row.side === "sell" ? row.remaining_quantity : 0,
      fulfillmentDeposit: row.side === "sell" ? money(row.unit_fulfillment_deposit_amount * row.remaining_quantity) : null,
      expiresAt: row.expires_at,
      version: row.version,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private findIdempotency(actorId: string, key: string): IdempotencyRow | undefined {
    return this.database.prepare(
      "SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
    ).get(actorId, key) as IdempotencyRow | undefined;
  }

  private idempotencyResult(existing: IdempotencyRow, fingerprint: string): OrderCommandResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_status || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", statusCode: existing.response_status, response: JSON.parse(existing.response_json) as ApiResponse<OrderResponse> };
  }

  private fail(input: { userId: string; idempotencyKey: string; requestId: string }, now: string, statusCode: number, code: ApiErrorCode, message: string): OrderCommandResult {
    const response = failure(input.requestId, code, message);
    this.completeIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeIdempotency(actorId: string, key: string, statusCode: number, response: ApiResponse<OrderResponse>, now: string): void {
    const updated = this.database.prepare(
      "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
    ).run(statusCode, JSON.stringify(response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("双边委托幂等请求状态损坏");
  }
}

function money(amount: number) { return { amount, currency: "GAME_CREDIT" as const }; }

/** 预览版本由不可变报价 + 方向 + 数量 + 限价带 + 预占金额派生，确保任一变化都需重新预览。 */
function previewVersionHash(quoteId: string, quoteVersion: string, side: OrderSide, quantity: number, min: number, max: number, reservedFunds: number): string {
  return createHash("sha256").update(canonicalizeRequest({ quoteId, quoteVersion, side, quantity, min, max, reservedFunds, preview: ORDER_PREVIEW_VERSION, rule: ORDER_RULE_VERSION })).digest("hex");
}

export function orderCreateRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}

export function orderCancelRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}
