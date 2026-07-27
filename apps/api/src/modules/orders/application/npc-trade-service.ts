import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  canonicalizeRequest,
  type AccountBalanceDto,
  type ApiResponse,
  type InventoryHoldingDto,
  type NpcBuyPreviewDto,
  type NpcSellPreviewDto,
  type NpcTradeDto
} from "@mtg-market/contracts";
import { InventoryService } from "../../inventory/application/inventory-service.js";
import { enqueueMarketRepriceJob } from "../../jobs/application/task-service.js";
import { MarketService, type NpcSettlementQuote } from "../../market/application/market-service.js";
import { UserService } from "../../users/application/user-service.js";
import { failure, success } from "../../../shared/http/api-response.js";

type LimitsRow = { max_quantity_per_trade: number; max_quantity_per_user_sku_day: number };
type IdempotencyRow = { request_fingerprint: string; status: string; response_status: number | null; response_json: string | null };
type NpcBuyResponse = { trade: NpcTradeDto; balance: AccountBalanceDto; holding: InventoryHoldingDto };
type NpcSellResponse = { trade: NpcTradeDto; balance: AccountBalanceDto; holding: InventoryHoldingDto };

export type NpcBuyPreviewResult = NpcBuyPreviewDto | "quote-unavailable" | "quote-stale";
export type NpcBuyCommandResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<NpcBuyResponse> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<NpcBuyResponse> }
  | { state: "conflict" }
  | { state: "in-progress" };
export type NpcSellPreviewResult = NpcSellPreviewDto | "quote-unavailable" | "quote-stale";
export type NpcSellCommandResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<NpcSellResponse> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<NpcSellResponse> }
  | { state: "conflict" }
  | { state: "in-progress" };

/**
 * I15B 的 NPC 买入用例。Order 模块只经 Market/User/Inventory 的 application 接口协作；
 * 成交、账本、库存、事实/outbox、审计和幂等结果共享一个 SQLite 短事务。
 */
export class NpcTradeService {
  private readonly inventory: InventoryService;
  private readonly users: UserService;
  private readonly market: MarketService;

  constructor(private readonly database: Database.Database) {
    this.inventory = new InventoryService(database);
    this.users = new UserService(database);
    this.market = new MarketService(database);
  }

  buyPreview(userId: string, skuId: string, quantity: number, now = new Date()): NpcBuyPreviewResult {
    const quote = this.market.npcSettlementQuote(skuId, "buy");
    if (!quote || !quote.tradable) return "quote-unavailable";
    const nowIso = now.toISOString();
    if (quote.validUntil <= nowIso) return "quote-stale";
    return this.previewForQuote(userId, quantity, quote, nowIso);
  }

  buy(input: {
    userId: string;
    skuId: string;
    quoteId: string;
    quoteVersion: string;
    quantity: number;
    maxUnitPrice: number;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): NpcBuyCommandResult {
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

      const quote = this.market.npcSettlementQuote(input.skuId, "buy", input.quoteId);
      if (!quote || !quote.tradable) return this.completeFailure(input, now, 404, "PRICE_UNAVAILABLE", "该 SKU 暂无可结算报价");
      if (quote.quoteVersion !== input.quoteVersion || quote.validUntil <= now)
        return this.completeFailure(input, now, 409, "VERSION_STALE", "报价已过期或版本已更新，请重新预览");
      if (quote.unitPriceAmount > input.maxUnitPrice)
        return this.completeFailure(input, now, 409, "VERSION_STALE", "当前成交价超过确认的限价，请重新预览");

      const preview = this.previewForQuote(input.userId, input.quantity, quote, now);
      if (!preview.canPurchase) {
        if (preview.unavailableReason === "archive_required")
          return this.completeFailure(input, now, 409, "RESOURCE_CONFLICT", "请先创建游戏存档");
        if (preview.unavailableReason === "insufficient_balance")
          return this.completeFailure(input, now, 409, "INSUFFICIENT_BALANCE", "可用余额不足，无法完成 NPC 买入");
        return this.completeFailure(input, now, 409, "RULE_VIOLATION", "本次交易超过服务器交易量限制");
      }

      const tradeId = randomUUID();
      const balance = this.users.spendForNpcBuy(input.userId, preview.total.amount, now, `npc-buy:${tradeId}`);
      if (balance === "insufficient")
        return this.completeFailure(input, now, 409, "INSUFFICIENT_BALANCE", "可用余额不足，无法完成 NPC 买入");
      const holding = this.inventory.acquireInLedgerTransaction({
        userId: input.userId,
        skuId: input.skuId,
        quantityDelta: input.quantity,
        unitCostAmount: quote.unitPriceAmount,
        reason: "npc_buy",
        correlationId: tradeId,
        now
      });
      if (holding === "insufficient") throw new Error("NPC 买入库存写入失败");

      const settlementDate = now.slice(0, 10);
      this.database.prepare(
        "INSERT INTO npc_trades (id, user_id, sku_id, side, quote_id, quote_version, unit_price_amount, unit_fee_amount, total_amount, quantity, settlement_date, created_at) VALUES (?, ?, ?, 'buy', ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(tradeId, input.userId, input.skuId, quote.quoteId, quote.quoteVersion, quote.unitPriceAmount, quote.unitFeeAmount, preview.total.amount, input.quantity, settlementDate, now);
      const trade = this.tradeDto(tradeId, input.userId, input.skuId, "buy", input.quantity, quote, preview.total.amount, now);
      const eventId = this.writeSettlementEvent(trade, input.userId, input.skuId, "buy", input.quantity, quote, now);
      enqueueMarketRepriceJob(this.database, `fact-event:${eventId}`, now);
      this.users.writeEconomicAudit(input.userId, "npc.trade.settled", "npc_trade", tradeId, input.requestId, {
        skuId: input.skuId, side: "buy", quantity: input.quantity, quoteId: quote.quoteId,
        quoteVersion: quote.quoteVersion, unitPriceAmount: quote.unitPriceAmount,
        unitFeeAmount: quote.unitFeeAmount, totalAmount: preview.total.amount
      }, now);
      const response = success(input.requestId, { trade, balance, holding });
      this.completeIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  /** I16B 的 NPC 卖出预览；`quantity=all` 只解析此刻可用库存。 */
  sellPreview(userId: string, skuId: string, quantity: number | "all", now = new Date()): NpcSellPreviewResult {
    const quote = this.market.npcSettlementQuote(skuId, "sell");
    if (!quote || !quote.tradable) return "quote-unavailable";
    const nowIso = now.toISOString();
    if (quote.validUntil <= nowIso) return "quote-stale";
    const resolvedQuantity = quantity === "all" ? (this.inventory.holding(userId, skuId)?.availableQuantity ?? 0) : quantity;
    return this.sellPreviewForQuote(userId, resolvedQuantity, quote, nowIso);
  }

  sell(input: {
    userId: string;
    skuId: string;
    quoteId: string;
    quoteVersion: string;
    quantity: number;
    minUnitPrice: number;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): NpcSellCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.sellIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.sellIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }

      const quote = this.market.npcSettlementQuote(input.skuId, "sell", input.quoteId);
      if (!quote || !quote.tradable) return this.completeSellFailure(input, now, 404, "PRICE_UNAVAILABLE", "该 SKU 暂无可结算报价");
      if (quote.quoteVersion !== input.quoteVersion || quote.validUntil <= now)
        return this.completeSellFailure(input, now, 409, "VERSION_STALE", "报价已过期或版本已更新，请重新预览");
      if (quote.unitPriceAmount < input.minUnitPrice)
        return this.completeSellFailure(input, now, 409, "VERSION_STALE", "当前收购价低于确认的限价，请重新预览");

      const preview = this.sellPreviewForQuote(input.userId, input.quantity, quote, now);
      if (!preview.canSell) {
        if (preview.unavailableReason === "archive_required")
          return this.completeSellFailure(input, now, 409, "RESOURCE_CONFLICT", "请先创建游戏存档");
        if (preview.unavailableReason === "insufficient_inventory")
          return this.completeSellFailure(input, now, 409, "INSUFFICIENT_INVENTORY", "可用库存不足，锁定库存不可出售");
        return this.completeSellFailure(input, now, 409, "RULE_VIOLATION", "本次交易超过服务器交易量限制");
      }

      const tradeId = randomUUID();
      const holding = this.inventory.disposeAvailableInLedgerTransaction({
        userId: input.userId,
        skuId: input.skuId,
        quantityDelta: -input.quantity,
        reason: "npc_sell",
        correlationId: tradeId,
        now
      });
      if (holding === "insufficient") return this.completeSellFailure(input, now, 409, "INSUFFICIENT_INVENTORY", "可用库存不足，锁定库存不可出售");
      const balance = this.users.creditForNpcSell(input.userId, preview.total.amount, now, `npc-sell:${tradeId}`);
      if (balance === "missing") throw new Error("NPC 卖出账户写入失败");

      const settlementDate = now.slice(0, 10);
      this.database.prepare(
        "INSERT INTO npc_trades (id, user_id, sku_id, side, quote_id, quote_version, unit_price_amount, unit_fee_amount, total_amount, quantity, settlement_date, created_at) VALUES (?, ?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(tradeId, input.userId, input.skuId, quote.quoteId, quote.quoteVersion, quote.unitPriceAmount, quote.unitFeeAmount, preview.total.amount, input.quantity, settlementDate, now);
      const trade = this.tradeDto(tradeId, input.userId, input.skuId, "sell", input.quantity, quote, preview.total.amount, now);
      const eventId = this.writeSettlementEvent(trade, input.userId, input.skuId, "sell", input.quantity, quote, now);
      enqueueMarketRepriceJob(this.database, `fact-event:${eventId}`, now);
      this.users.writeEconomicAudit(input.userId, "npc.trade.settled", "npc_trade", tradeId, input.requestId, {
        skuId: input.skuId, side: "sell", quantity: input.quantity, quoteId: quote.quoteId,
        quoteVersion: quote.quoteVersion, unitPriceAmount: quote.unitPriceAmount,
        unitFeeAmount: quote.unitFeeAmount, totalAmount: preview.total.amount
      }, now);
      const response = success(input.requestId, { trade, balance, holding });
      this.completeSellIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  private previewForQuote(userId: string, quantity: number, quote: NpcSettlementQuote, now: string): NpcBuyPreviewDto {
    const limits = this.limits();
    const day = now.slice(0, 10);
    const used = (this.database.prepare(
      "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM npc_trades WHERE user_id = ? AND sku_id = ? AND side = 'buy' AND settlement_date = ?"
    ).get(userId, quote.skuId, day) as { quantity: number }).quantity;
    const remaining = Math.max(0, limits.max_quantity_per_user_sku_day - used);
    const totalAmount = multiply(quote.unitPriceAmount, quantity, "NPC 买入总价");
    const feeAmount = multiply(quote.unitFeeAmount, quantity, "NPC 买入费用");
    const balance = this.users.balance(userId);
    const unavailableReason = !balance
      ? "archive_required"
      : quantity > limits.max_quantity_per_trade || quantity > remaining
        ? "trade_limit_reached"
        : balance.available.amount < totalAmount
          ? "insufficient_balance"
          : null;
    return {
      skuId: quote.skuId,
      quantity,
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
      unitPrice: money(quote.unitPriceAmount),
      unitFee: money(quote.unitFeeAmount),
      total: money(totalAmount),
      fee: money(feeAmount),
      validUntil: quote.validUntil,
      limit: { maxQuantityPerTrade: limits.max_quantity_per_trade, maxQuantityPerUserSkuDay: limits.max_quantity_per_user_sku_day, remainingQuantityToday: remaining },
      canPurchase: unavailableReason === null,
      unavailableReason
    };
  }

  private sellPreviewForQuote(userId: string, quantity: number, quote: NpcSettlementQuote, now: string): NpcSellPreviewDto {
    const limits = this.limits();
    const day = now.slice(0, 10);
    const used = (this.database.prepare(
      "SELECT COALESCE(SUM(quantity), 0) AS quantity FROM npc_trades WHERE user_id = ? AND sku_id = ? AND side = 'sell' AND settlement_date = ?"
    ).get(userId, quote.skuId, day) as { quantity: number }).quantity;
    const remaining = Math.max(0, limits.max_quantity_per_user_sku_day - used);
    const holding = this.inventory.holding(userId, quote.skuId);
    const availableQuantity = holding?.availableQuantity ?? 0;
    const totalAmount = quantity === 0 ? 0 : multiply(quote.unitPriceAmount, quantity, "NPC 卖出总价");
    const feeAmount = quantity === 0 ? 0 : multiply(quote.unitFeeAmount, quantity, "NPC 卖出费用");
    const unavailableReason = !this.users.balance(userId)
      ? "archive_required"
      : quantity > availableQuantity
        ? "insufficient_inventory"
        : quantity > limits.max_quantity_per_trade || quantity > remaining
          ? "trade_limit_reached"
          : null;
    return {
      skuId: quote.skuId,
      quantity,
      availableQuantity,
      quoteId: quote.quoteId,
      quoteVersion: quote.quoteVersion,
      unitPrice: money(quote.unitPriceAmount),
      unitFee: money(quote.unitFeeAmount),
      total: money(totalAmount),
      fee: money(feeAmount),
      validUntil: quote.validUntil,
      limit: { maxQuantityPerTrade: limits.max_quantity_per_trade, maxQuantityPerUserSkuDay: limits.max_quantity_per_user_sku_day, remainingQuantityToday: remaining },
      canSell: unavailableReason === null,
      unavailableReason
    };
  }

  private limits(): LimitsRow {
    const limits = this.database.prepare(
      "SELECT max_quantity_per_trade, max_quantity_per_user_sku_day FROM npc_trade_limits WHERE singleton = 1"
    ).get() as LimitsRow | undefined;
    if (!limits) throw new Error("NPC 交易额度未初始化");
    return limits;
  }

  private tradeDto(id: string, userId: string, skuId: string, side: "buy" | "sell", quantity: number, quote: NpcSettlementQuote, totalAmount: number, settledAt: string): NpcTradeDto {
    return { id, userId, skuId, side, quantity, quoteId: quote.quoteId, quoteVersion: quote.quoteVersion, unitPrice: money(quote.unitPriceAmount), unitFee: money(quote.unitFeeAmount), total: money(totalAmount), fee: money(multiply(quote.unitFeeAmount, quantity, `NPC ${side === "buy" ? "买入" : "卖出"}费用`)), settledAt };
  }

  private writeSettlementEvent(trade: NpcTradeDto, userId: string, skuId: string, side: "buy" | "sell", quantity: number, quote: NpcSettlementQuote, now: string): string {
    const eventId = randomUUID();
    const event = {
      id: eventId,
      type: "npc.trade.settled" as const,
      version: 1 as const,
      occurredAt: now,
      correlationId: trade.id,
      payload: { tradeId: trade.id, userId, skuId, side, quantity, unitPrice: trade.unitPrice, total: trade.total, quoteVersion: quote.quoteVersion }
    };
    this.database.prepare(
      "INSERT INTO fact_events (id, event_type, aggregate_type, aggregate_id, version, payload_json, occurred_at) VALUES (?, 'npc.trade.settled', 'npc_trade', ?, 1, ?, ?)"
    ).run(eventId, trade.id, JSON.stringify(event), now);
    this.database.prepare(
      "INSERT INTO outbox (id, event_id, destination, payload_json, status, created_at, dispatched_at) VALUES (?, ?, 'market.fact-event', ?, 'pending', ?, NULL)"
    ).run(randomUUID(), eventId, JSON.stringify(event), now);
    return eventId;
  }

  private findIdempotency(actorId: string, key: string): IdempotencyRow | undefined {
    return this.database.prepare(
      "SELECT request_fingerprint, status, response_status, response_json FROM idempotency_requests WHERE actor_id = ? AND idempotency_key = ?"
    ).get(actorId, key) as IdempotencyRow | undefined;
  }

  private idempotencyResult(existing: IdempotencyRow, fingerprint: string): NpcBuyCommandResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_status || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", statusCode: existing.response_status, response: JSON.parse(existing.response_json) as ApiResponse<NpcBuyResponse> };
  }

  private sellIdempotencyResult(existing: IdempotencyRow, fingerprint: string): NpcSellCommandResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_status || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", statusCode: existing.response_status, response: JSON.parse(existing.response_json) as ApiResponse<NpcSellResponse> };
  }

  private completeFailure(input: { userId: string; idempotencyKey: string; requestId: string }, now: string, statusCode: number, code: "PRICE_UNAVAILABLE" | "VERSION_STALE" | "RESOURCE_CONFLICT" | "INSUFFICIENT_BALANCE" | "RULE_VIOLATION", message: string): NpcBuyCommandResult {
    const response = failure(input.requestId, code, message);
    this.completeIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeIdempotency(actorId: string, key: string, statusCode: number, response: ApiResponse<NpcBuyResponse>, now: string): void {
    const updated = this.database.prepare(
      "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
    ).run(statusCode, JSON.stringify(response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("NPC 买入幂等请求状态损坏");
  }

  private completeSellFailure(input: { userId: string; idempotencyKey: string; requestId: string }, now: string, statusCode: number, code: "PRICE_UNAVAILABLE" | "VERSION_STALE" | "RESOURCE_CONFLICT" | "INSUFFICIENT_INVENTORY" | "RULE_VIOLATION", message: string): NpcSellCommandResult {
    const response = failure(input.requestId, code, message);
    this.completeSellIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeSellIdempotency(actorId: string, key: string, statusCode: number, response: ApiResponse<NpcSellResponse>, now: string): void {
    const updated = this.database.prepare(
      "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
    ).run(statusCode, JSON.stringify(response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("NPC 卖出幂等请求状态损坏");
  }
}

function money(amount: number) { return { amount, currency: "GAME_CREDIT" as const }; }
function multiply(left: number, right: number, label: string): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right <= 0 || !Number.isSafeInteger(left * right)) throw new RangeError(`${label} 超出安全整数范围`);
  return left * right;
}

export function npcBuyRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}

export function npcSellRequestFingerprint(body: unknown): string {
  return createHash("sha256").update(canonicalizeRequest(body)).digest("hex");
}
