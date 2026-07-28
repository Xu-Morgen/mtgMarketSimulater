import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  calculateOrderFees,
  isFulfillmentOverdue,
  isWithinOrderLimitBand,
  matchOrders,
  ORDER_FULFILLMENT_RULE_VERSION,
  ORDER_MATCH_RULE_VERSION,
  ORDER_PREVIEW_VERSION,
  ORDER_RULE_VERSION,
  resolveFulfillmentDeadline,
  resolveOrderLimitBand,
  validateOrderCancellation,
  validateTradeCancellation,
  validateTradeFulfillment,
  type MatchLeg,
  type MatchOrderInput
} from "@mtg-market/rules";
import {
  canonicalizeRequest,
  type AccountBalanceDto,
  type ApiErrorCode,
  type ApiResponse,
  type BilateralOrderBookDto,
  type BilateralOrderBookLevelDto,
  type BilateralOrderDto,
  type BilateralOrderPreviewDto,
  type BilateralTradeDto,
  type FeeDto,
  type MatchResultDto,
  type OrderSide,
  type OrderStatus,
  type Page,
  type PlayerBilateralTradeDto
} from "@mtg-market/contracts";
import { InventoryService } from "../../inventory/application/inventory-service.js";
import { enqueueMarketRepriceJob, enqueueOrderExpireJob } from "../../jobs/application/task-service.js";
import { MarketService } from "../../market/application/market-service.js";
import { UserService } from "../../users/application/user-service.js";
import { success, failure } from "../../../shared/http/api-response.js";
import {
  assertPositiveQuantity,
  BILATERAL_TRADE_ENTITY_TYPE,
  isExpirableOrder,
  ORDER_EXPIRE_TASK_PREFIX,
  ORDER_FULFILLMENT_DEPOSIT_HOLD_REASON,
  ORDER_FULFILLMENT_FUND_HOLD_REASON,
  ORDER_HOLD_ENTITY_TYPE,
  P2P_BUY_LEDGER_REASON,
  P2P_DEPOSIT_FORFEITED_CORRELATION_PREFIX,
  P2P_SELL_LEDGER_REASON
} from "../domain/order.js";

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

/** 撮合输入加载的委托行；rowid 作为单调 sequence 保证 createdAt 并列时仍稳定可重放。 */
type MatchableOrderRow = OrderRow & { rowid: number };

/** bilateral_trades 落库后回读的成交行，用于返回 MatchResultDto 与审计。 */
type TradeRow = {
  id: string;
  sku_id: string;
  buy_order_id: string;
  sell_order_id: string;
  buyer_user_id: string;
  seller_user_id: string;
  quantity: number;
  execution_price_amount: number;
  buyer_fee_amount: number;
  seller_fee_amount: number;
  rule_version: string;
  status: string;
  created_at: string;
  updated_at: string;
  fulfillment_deadline: string;
};

/**
 * I20B 履约/取消/到期用例读取的完整成交行；含 holdIds 与卖单单位保证金、卖方原 inventory hold
 * 数量。holdIds 仅在服务端事务内使用，绝不写入响应或前端 DTO。
 */
type FullTradeRow = TradeRow & {
  buyer_funds_hold_id: string | null;
  seller_inventory_hold_id: string | null;
  seller_deposit_hold_id: string | null;
  seller_inventory_quantity: number;
  sell_unit_fulfillment_deposit_amount: number;
};

/** I19F 玩家成交只读查询行；比 TradeRow 多读卖方待履约库存数量与单位保证金（用于推导已成交保证金）。 */
type PlayerTradeRow = TradeRow & { seller_inventory_quantity: number; sell_unit_fulfillment_deposit_amount: number };

export type OrderPreviewResult = BilateralOrderPreviewDto | "quote-unavailable" | "quote-stale" | "insufficient-quantity";

export type OrderCommandResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<OrderResponse> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<OrderResponse> }
  | { state: "conflict" }
  | { state: "in-progress" };

/** I20B 履约/取消履约的响应；trade 为脱敏成交 DTO，balance 取请求者视角便于前端展示。 */
export type TradeCommandResponse = { trade: BilateralTradeDto; balance: AccountBalanceDto };
export type TradeCommandResult =
  | { state: "completed"; statusCode: number; response: ApiResponse<TradeCommandResponse> }
  | { state: "replayed"; statusCode: number; response: ApiResponse<TradeCommandResponse> }
  | { state: "conflict" }
  | { state: "in-progress" };

/**
 * I18B 的双边委托、I19B 的撮合与 I20B 的模拟履约用例。Order 模块只经 Market/User/Inventory
 * 的 application 接口协作；委托、撮合、履约、取消、到期、资金/库存/保证金结算、审计和幂等结果
 * 均在同一个 SQLite 短事务内提交或回滚。撮合不转移最终所有权、不写 p2p.trade.settled；
 * 履约结算所有权转移与卖方收入/保证金、写 p2p.trade.settled；取消履约退回买方资金、扣除卖方
 * 保证金并恢复卖方库存，不写 p2p.trade.settled。order.expire 到期把委托转 expired、成交转取消履约。
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
      // I20B：委托创建即投递到期回收任务（runAfter=expires_at；uniqueKey 去重，重复投递不产生多行 job）。
      this.enqueueOrderExpire({ kind: "order", id: orderId, runAfter: expiresAt });
      const response = success(input.requestId, { order });
      this.completeIdempotency(input.userId, input.idempotencyKey, 201, response, now);
      return { state: "completed", statusCode: 201, response };
    });
  }

  /**
   * I19B 撮合用例。以独立短事务加载 skuId 下全部 open/partially_filled 买卖委托，调用
   * order-matching/v1 纯规则得到成交 legs，再逐条以条件 UPDATE 与 hold 转换原子落库。
   * 并发撮合由 SQLite 短事务串行 + 条件更新 + bilateral_trades 唯一约束保证至多执行一次、
   * 业务结果至多一次；不转移最终所有权、不写 p2p.trade.settled、不结算卖方收入/保证金（留 I20B）。
   */
  match(input: { skuId: string; requestId: string; now?: Date }): MatchResultDto {
    const now = (input.now ?? new Date()).toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const { buyOrders, sellOrders } = this.loadMatchableOrders(input.skuId, now);
      const matched = matchOrders({
        ruleVersion: ORDER_MATCH_RULE_VERSION,
        minimumPrice: this.minimumPrice(),
        buyOrders,
        sellOrders
      });
      const tradeIds: string[] = [];
      for (const leg of matched.legs) {
        const trade = this.applyLeg(leg, input.requestId, now);
        if (trade) tradeIds.push(trade.id);
      }
      const trades = tradeIds.map((id) => this.toTradeDto(this.findTradeRow(id)!));
      return { skuId: input.skuId, trades, capturedAt: now };
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

  /**
   * I20B 确认履约：在单个 SQLite 短事务内扣买方待履约资金、把库存转入买方、结算卖方收入（已扣
   * order_fee）、返还卖方保证金，并追加 `p2p.trade.settled` 事实事件与重定价任务；不引入实体物流状态。
   * 买卖任一方均可发起。状态机由条件 UPDATE（`WHERE status='matched_pending_fulfillment'`）保证并发与
   * 重放至多产生一次业务结果；幂等键同参重放返回首次响应，异参返回 conflict。
   */
  fulfill(input: {
    userId: string;
    tradeId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): TradeCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.tradeIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.tradeIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }

      const trade = this.findFullTradeRow(input.tradeId);
      if (!trade || (trade.buyer_user_id !== input.userId && trade.seller_user_id !== input.userId))
        return this.tradeFail(input, now, 404, "RESOURCE_NOT_FOUND", "未找到该成交");
      const validation = validateTradeFulfillment(trade.status);
      if (!validation.ok)
        return this.tradeFail(input, now, 409, "RESOURCE_CONFLICT", `当前状态 ${trade.status} 不可确认履约`);

      const buyerFee = trade.buyer_fee_amount;
      const sellerFee = trade.seller_fee_amount;
      const grossSellerRevenue = trade.quantity * trade.execution_price_amount;
      // 卖方收入 = 数量×成交价 - 已成交 order_fee（撮合时未预占 order_fee，这里从收入扣除）。
      const sellerRevenue = Math.max(0, grossSellerRevenue - sellerFee);
      // 买方实际欠款 = 数量×成交价 + 已成交 order_fee（按成交价结算，不是买单限价）。
      const buyerOwed = trade.quantity * trade.execution_price_amount + buyerFee;

      // 买方扣款：撮合时按买单限价预占的待履约资金 hold 可能高于实际欠款（限价 >= 成交价）；
      // 先释放全量 hold 退回 available，再按成交价扣款，使限价与成交价之间的差额回到买方。
      let buyerBalance: AccountBalanceDto | null = null;
      if (trade.buyer_funds_hold_id) {
        const released = this.users.releaseOrderFunds(trade.buyer_user_id, trade.buyer_funds_hold_id, now);
        if (released === "not-active") throw new Error(`履约买方资金释放失败：hold ${trade.buyer_funds_hold_id} 非活跃，事务回滚`);
        const spent = this.users.funds().spendAvailableFunds(trade.buyer_user_id, buyerOwed, now, `p2p-buy:${trade.id}`, P2P_BUY_LEDGER_REASON);
        if (spent === "insufficient") throw new Error("履约买方按成交价扣款失败：资金不足，事务回滚");
        buyerBalance = spent;
      }

      // 买方库存转入：以成交价为成本取得数量。
      this.inventory.acquireInLedgerTransaction({
        userId: trade.buyer_user_id,
        skuId: trade.sku_id,
        quantityDelta: trade.quantity,
        unitCostAmount: trade.execution_price_amount,
        reason: P2P_BUY_LEDGER_REASON,
        correlationId: trade.id,
        now
      });

      // 卖方保证金返还：releaseFunds 把保证金 hold 退回 available。
      if (trade.seller_deposit_hold_id) {
        const released = this.users.releaseOrderFunds(trade.seller_user_id, trade.seller_deposit_hold_id, now);
        if (released === "not-active") throw new Error(`履约卖方保证金返还失败：hold ${trade.seller_deposit_hold_id} 非活跃，事务回滚`);
      }

      // 卖方收入到账（已扣 order_fee，可视为 0 但不报错）。
      if (sellerRevenue > 0) {
        const credited = this.users.funds().creditAvailableFunds(trade.seller_user_id, sellerRevenue, now, `p2p-sell:${trade.id}`, P2P_SELL_LEDGER_REASON);
        if (credited === "missing") throw new Error("履约卖方收入到账失败：账户不存在，事务回滚");
      }

      // 成交状态推进为 fulfilled（条件 UPDATE，并发至多一次）。
      const advanced = this.database.prepare(
        "UPDATE bilateral_trades SET status = 'fulfilled', updated_at = ? WHERE id = ? AND status = 'matched_pending_fulfillment'"
      ).run(now, trade.id);
      if (advanced.changes !== 1) throw new Error(`履约成交状态迁移冲突：trade=${trade.id}，事务回滚`);

      // p2p.trade.settled 事实事件：market-service 按 liquidity 维度消费一次 quantity。
      const eventId = this.writeP2pTradeSettledEvent(trade, now);

      this.users.writeEconomicAudit(trade.buyer_user_id, "bilateral_trade.fulfilled", "bilateral_trade", trade.id, input.requestId, {
        skuId: trade.sku_id, role: "buyer", quantity: trade.quantity, executionPrice: trade.execution_price_amount,
        buyerFee, sellerFee, sellerRevenue, ruleVersion: trade.rule_version, buyerFundsHoldId: trade.buyer_funds_hold_id,
        eventId, fulfillmentDeadline: trade.fulfillment_deadline
      }, now);
      this.users.writeEconomicAudit(trade.seller_user_id, "bilateral_trade.fulfilled", "bilateral_trade", trade.id, input.requestId, {
        skuId: trade.sku_id, role: "seller", quantity: trade.quantity, executionPrice: trade.execution_price_amount,
        buyerFee, sellerFee, sellerRevenue, ruleVersion: trade.rule_version, sellerDepositHoldId: trade.seller_deposit_hold_id,
        eventId, fulfillmentDeadline: trade.fulfillment_deadline
      }, now);

      const response = success(input.requestId, { trade: this.toTradeDto(this.findTradeRow(trade.id)!), balance: buyerBalance ?? this.users.balance(trade.buyer_user_id)! });
      this.completeTradeIdempotency(input.userId, input.idempotencyKey, 200, response, now);
      return { state: "completed", statusCode: 200, response };
    });
  }

  /**
   * I20B 取消履约：在单个 SQLite 短事务内退回买方资金、扣除（没收）卖方已冻结保证金、恢复卖方库存，
   * 并写完整审计；不产生 `p2p.trade.settled`。买卖任一方均可发起，到期回收也复用本路径。
   */
  cancelTrade(input: {
    userId: string;
    tradeId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestId: string;
    now?: Date;
  }): TradeCommandResult {
    const now = (input.now ?? new Date()).toISOString();
    return this.inventory.withLedgerTransaction(() => {
      const existing = this.findIdempotency(input.userId, input.idempotencyKey);
      if (existing) return this.tradeIdempotencyResult(existing, input.requestFingerprint);
      try {
        this.database.prepare(
          "INSERT INTO idempotency_requests (id, actor_id, idempotency_key, request_fingerprint, status, response_status, response_json, created_at, completed_at) VALUES (?, ?, ?, ?, 'running', NULL, NULL, ?, NULL)"
        ).run(randomUUID(), input.userId, input.idempotencyKey, input.requestFingerprint, now);
      } catch {
        const raced = this.findIdempotency(input.userId, input.idempotencyKey);
        return raced ? this.tradeIdempotencyResult(raced, input.requestFingerprint) : { state: "in-progress" };
      }

      const trade = this.findFullTradeRow(input.tradeId);
      if (!trade || (trade.buyer_user_id !== input.userId && trade.seller_user_id !== input.userId))
        return this.tradeFail(input, now, 404, "RESOURCE_NOT_FOUND", "未找到该成交");
      const validation = validateTradeCancellation(trade.status);
      if (!validation.ok)
        return this.tradeFail(input, now, 409, "RESOURCE_CONFLICT", `当前状态 ${trade.status} 不可取消履约`);

      this.applyTradeCancellation(trade, input.requestId, now, "bilateral_trade.cancelled");

      const response = success(input.requestId, { trade: this.toTradeDto(this.findTradeRow(trade.id)!), balance: this.users.balance(input.userId)! });
      this.completeTradeIdempotency(input.userId, input.idempotencyKey, 200, response, now);
      return { state: "completed", statusCode: 200, response };
    });
  }

  /**
   * I20B 到期回收入口（供 order.expire handler 调用）。payload `{ kind, id }`：
   * - `order`：未撮合完且 expires_at<=now 的委托转 expired 并释放剩余资金/库存/保证金预占。
   * - `trade`：待履约且 fulfillment_deadline<=now 的成交走取消履约路径（系统 actor）。
   * 已迁移到终态的实体直接跳过（幂等），失败由 TaskWorker 重试。
   */
  expireByPayload(payload: unknown, now = new Date()): void {
    const cast = payload as { kind?: string; id?: string };
    if (cast.kind === "order" && typeof cast.id === "string") this.expireOrder(cast.id, now);
    else if (cast.kind === "trade" && typeof cast.id === "string") this.expireTrade(cast.id, now);
    // 未知 payload 静默跳过：handler 不应因坏 payload 让任务进入死信，状态机兜底已足够。
  }

  /** 到期委托：条件 UPDATE 转 expired 并释放剩余预占；非 expirable 或未到期则跳过。 */
  expireOrder(orderId: string, now = new Date()): void {
    const iso = now.toISOString();
    this.inventory.withLedgerTransaction(() => {
      const row = this.findOrderRow(orderId);
      if (!row || !isExpirableOrder(row.status as OrderStatus)) return;
      if (row.expires_at > iso) return; // 未到期（重复投递或时钟漂移）跳过。
      const advanced = this.database.prepare(
        "UPDATE bilateral_orders SET status = 'expired', cancelled_at = ?, version = version + 1, updated_at = ? WHERE id = ? AND status IN ('open', 'partially_filled') AND version = ?"
      ).run(iso, iso, orderId, row.version);
      if (advanced.changes !== 1) return; // 并发已被撤单或撮合，跳过。
      this.releaseOrderReservedFunds(row, iso);
      this.users.writeEconomicAudit(row.user_id, "bilateral_order.expired", "bilateral_order", orderId, `order.expire:${orderId}`, {
        side: row.side, skuId: row.sku_id, remainingQuantity: row.remaining_quantity,
        releasedFunds: row.reserved_funds_amount, releasedInventoryQuantity: row.side === "sell" ? row.remaining_quantity : 0,
        expiresAt: row.expires_at
      }, iso);
    });
  }

  /** 到期成交：待履约且期限已过则走取消履约路径（系统 actor，无幂等键）；终态跳过。 */
  expireTrade(tradeId: string, now = new Date()): void {
    const iso = now.toISOString();
    this.inventory.withLedgerTransaction(() => {
      const trade = this.findFullTradeRow(tradeId);
      if (!trade || trade.status !== "matched_pending_fulfillment") return;
      if (!isFulfillmentOverdue(ORDER_FULFILLMENT_RULE_VERSION, trade.fulfillment_deadline, iso)) return;
      this.applyTradeCancellation(trade, `order.expire:${tradeId}`, iso, "bilateral_trade.expired");
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

  /**
   * I19F 玩家视角成交只读查询。从 `bilateral_trades` 读取当前玩家作为买方或卖方的成交，
   * 投影为脱敏的 `PlayerBilateralTradeDto`：只返回当前玩家自己的委托 ID、角色与已转入待履约的
   * 资金/库存；对手 userId、对手 orderId 与所有 holdId 一律不返回。纯读、不写事务、不调幂等键。
   */
  listPlayerTrades(userId: string, filters: { skuId?: string; cursor?: string; limit: number }): Page<PlayerBilateralTradeDto> {
    const where = ["(t.buyer_user_id = ? OR t.seller_user_id = ?)"]; const values: unknown[] = [userId, userId];
    if (filters.skuId) { where.push("t.sku_id = ?"); values.push(filters.skuId); }
    const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("成交分页游标无效");
    const clause = `WHERE ${where.join(" AND ")}`;
    const total = (this.database.prepare(`SELECT COUNT(*) AS count FROM bilateral_trades t ${clause}`).get(...values) as { count: number }).count;
    const rows = this.database.prepare(
      `${this.selectPlayerTradeSql()} ${clause} ORDER BY t.created_at DESC, t.id DESC LIMIT ? OFFSET ?`
    ).all(...values, filters.limit + 1, offset) as PlayerTradeRow[];
    const hasMore = rows.length > filters.limit;
    return { items: rows.slice(0, filters.limit).map((row) => this.toPlayerTradeDto(row, userId)), page: { total, hasMore, nextCursor: hasMore ? String(offset + filters.limit) : null } };
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

  /** 加载 skuId 下未过期且仍可撮合的买卖委托，按 side 分组并带 rowid 作为稳定 sequence。 */
  private loadMatchableOrders(skuId: string, now: string): { buyOrders: MatchOrderInput[]; sellOrders: MatchOrderInput[] } {
    const rows = this.database.prepare(
      `SELECT id, user_id, sku_id, side, status, original_quantity, remaining_quantity, limit_price_amount, unit_fee_amount, unit_fulfillment_deposit_amount, reserved_funds_amount, reserved_funds_hold_id, inventory_hold_id, quote_id, quote_version, preview_version, expires_at, cancelled_at, version, settlement_date, created_at, updated_at, rowid
       FROM bilateral_orders
       WHERE sku_id = ? AND status IN ('open', 'partially_filled') AND expires_at > ? AND remaining_quantity > 0
       ORDER BY side, limit_price_amount`
    ).all(skuId, now) as MatchableOrderRow[];
    const buyOrders: MatchOrderInput[] = [];
    const sellOrders: MatchOrderInput[] = [];
    for (const row of rows) {
      const order = { id: row.id, userId: row.user_id, limitPrice: row.limit_price_amount, remainingQuantity: row.remaining_quantity, createdAt: row.created_at, sequence: row.rowid };
      if (row.side === "buy") buyOrders.push(order);
      else sellOrders.push(order);
    }
    return { buyOrders, sellOrders };
  }

  /**
   * 应用单条成交 leg：条件 UPDATE 扣减双方剩余数量（乐观锁），转换买方资金/卖方库存/卖方保证金
   * 为待履约持有，并写 bilateral_trades。任一步骤因并发已被消耗则跳过该 leg（返回 null），
   * 保证不会超卖、超扣或重复成交。事务回滚由 withLedgerTransaction 兜底。
   */
  private applyLeg(leg: MatchLeg, requestId: string, now: string): TradeRow | null {
    // 幂等保护：同对委托 + 同成交价已落 trade 则跳过（并发撮合至多一行成交）。
    const existing = this.database.prepare(
      "SELECT id FROM bilateral_trades WHERE buy_order_id = ? AND sell_order_id = ? AND execution_price_amount = ?"
    ).get(leg.buyOrderId, leg.sellOrderId, leg.executionPrice) as { id: string } | undefined;
    if (existing) return this.findTradeRow(existing.id) ?? null;

    const buyOrder = this.findOrderRow(leg.buyOrderId);
    const sellOrder = this.findOrderRow(leg.sellOrderId);
    if (!buyOrder || !sellOrder) return null;
    if (buyOrder.remaining_quantity < leg.quantity || sellOrder.remaining_quantity < leg.quantity) return null;

    // 条件 UPDATE 推进双方剩余数量与版本；任一失败（并发消耗）则整体跳过该 leg。
    const buyRemaining = buyOrder.remaining_quantity - leg.quantity;
    const sellRemaining = sellOrder.remaining_quantity - leg.quantity;
    const buyAdvanced = this.database.prepare(
      "UPDATE bilateral_orders SET remaining_quantity = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND remaining_quantity >= ?"
    ).run(buyRemaining, buyRemaining === 0 ? "matched_pending_fulfillment" : "partially_filled", now, buyOrder.id, buyOrder.version, leg.quantity);
    const sellAdvanced = this.database.prepare(
      "UPDATE bilateral_orders SET remaining_quantity = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND remaining_quantity >= ?"
    ).run(sellRemaining, sellRemaining === 0 ? "matched_pending_fulfillment" : "partially_filled", now, sellOrder.id, sellOrder.version, leg.quantity);
    if (buyAdvanced.changes !== 1 || sellAdvanced.changes !== 1) {
      // 并发已被其他撮合消耗；抛错回滚整笔事务以保证订单/资金/库存无半完成状态。
      throw new Error(`撮合 leg 并发冲突：buy=${buyOrder.id} sell=${sellOrder.id}`);
    }

    const tradeId = randomUUID();
    const unitFee = buyOrder.unit_fee_amount;
    const unitDeposit = sellOrder.unit_fulfillment_deposit_amount;
    const buyerFeeAmount = unitFee * leg.quantity;
    const sellerFeeAmount = unitFee * leg.quantity;
    // 买方待履约资金 = 已成交数量*限价 + 已成交 order_fee；卖方已成交保证金 = 已成交数量*单位保证金。
    const buyerFulfillmentFunds = leg.quantity * buyOrder.limit_price_amount + buyerFeeAmount;
    const sellerCapturedDeposit = unitDeposit * leg.quantity;

    // 转换买方资金：release 原全量 order_buy hold → reserve 已成交部分 order_fulfillment hold + 剩余 order_buy hold。
    let buyerFundsHoldId: string | null = null;
    if (buyOrder.reserved_funds_hold_id) {
      const released = this.users.releaseOrderFunds(buyOrder.user_id, buyOrder.reserved_funds_hold_id, now);
      if (released === "not-active") throw new Error(`撮合买方资金释放失败：hold ${buyOrder.reserved_funds_hold_id} 非活跃，事务回滚`);
      const fulfilledReserved = this.users.reserveOrderFunds(buyOrder.user_id, buyerFulfillmentFunds, { entityType: BILATERAL_TRADE_ENTITY_TYPE, entityId: tradeId, reason: ORDER_FULFILLMENT_FUND_HOLD_REASON }, now);
      if (fulfilledReserved === "insufficient") throw new Error("买方待履约资金重新预占失败：资金不足，事务回滚");
      buyerFundsHoldId = fulfilledReserved.holdId;
      if (buyRemaining > 0) {
        const remainingBuyFunds = buyRemaining * buyOrder.limit_price_amount + unitFee * buyRemaining;
        const remainingReserved = this.users.reserveOrderFunds(buyOrder.user_id, remainingBuyFunds, { entityType: ORDER_HOLD_ENTITY_TYPE, entityId: buyOrder.id, reason: "order_buy" }, now);
        if (remainingReserved === "insufficient") throw new Error("买方剩余委托资金重新预占失败：资金不足，事务回滚");
        this.database.prepare("UPDATE bilateral_orders SET reserved_funds_hold_id = ?, reserved_funds_amount = ?, updated_at = ? WHERE id = ?").run(remainingReserved.holdId, remainingBuyFunds, now, buyOrder.id);
      } else {
        this.database.prepare("UPDATE bilateral_orders SET reserved_funds_hold_id = NULL, reserved_funds_amount = 0, updated_at = ? WHERE id = ?").run(now, buyOrder.id);
      }
    }

    // 转换卖方库存：部分 capture 已成交数量（库存离开卖方持有，待履约）。
    const sellerInventoryHoldId: string | null = sellOrder.inventory_hold_id;
    if (sellOrder.inventory_hold_id) {
      const captured = this.inventory.capturePartialInLedgerTransaction({ userId: sellOrder.user_id, holdId: sellOrder.inventory_hold_id, captureQuantity: leg.quantity, correlationId: tradeId, now });
      if (captured === "not-active" || captured === "insufficient") throw new Error(`撮合卖方库存部分成交失败：hold ${sellOrder.inventory_hold_id}，事务回滚`);
    }

    // 转换卖方保证金：release 原全量 order_fulfillment_deposit hold → reserve 已成交部分 + 剩余。
    let sellerDepositHoldId: string | null = null;
    if (sellOrder.reserved_funds_hold_id) {
      const released = this.users.releaseOrderFunds(sellOrder.user_id, sellOrder.reserved_funds_hold_id, now);
      if (released === "not-active") throw new Error(`撮合卖方保证金释放失败：hold ${sellOrder.reserved_funds_hold_id} 非活跃，事务回滚`);
      const capturedReserved = this.users.reserveOrderFunds(sellOrder.user_id, sellerCapturedDeposit, { entityType: BILATERAL_TRADE_ENTITY_TYPE, entityId: tradeId, reason: ORDER_FULFILLMENT_DEPOSIT_HOLD_REASON }, now);
      if (capturedReserved === "insufficient") throw new Error("卖方已成交保证金重新预占失败：资金不足，事务回滚");
      sellerDepositHoldId = capturedReserved.holdId;
      if (sellRemaining > 0) {
        const remainingDeposit = unitDeposit * sellRemaining;
        const remainingReserved = this.users.reserveOrderFunds(sellOrder.user_id, remainingDeposit, { entityType: ORDER_HOLD_ENTITY_TYPE, entityId: sellOrder.id, reason: ORDER_FULFILLMENT_DEPOSIT_HOLD_REASON }, now);
        if (remainingReserved === "insufficient") throw new Error("卖方剩余保证金重新预占失败：资金不足，事务回滚");
        this.database.prepare("UPDATE bilateral_orders SET reserved_funds_hold_id = ?, reserved_funds_amount = ?, updated_at = ? WHERE id = ?").run(remainingReserved.holdId, remainingDeposit, now, sellOrder.id);
      } else {
        this.database.prepare("UPDATE bilateral_orders SET reserved_funds_hold_id = NULL, reserved_funds_amount = 0, updated_at = ? WHERE id = ?").run(now, sellOrder.id);
      }
    }

    // I20B：履约期限沿用委托有效期 ttl_seconds，从撮合时刻起算；到期由 order.expire 把成交推进为取消履约。
    const fulfillmentDeadline = resolveFulfillmentDeadline(ORDER_FULFILLMENT_RULE_VERSION, this.limits().ttl_seconds, now);

    this.database.prepare(
      `INSERT INTO bilateral_trades (id, sku_id, buy_order_id, sell_order_id, buyer_user_id, seller_user_id, quantity, execution_price_amount, buyer_fee_amount, seller_fee_amount, buyer_funds_hold_id, seller_inventory_hold_id, seller_deposit_hold_id, seller_inventory_quantity, rule_version, status, fulfillment_deadline, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'matched_pending_fulfillment', ?, ?, ?)`
    ).run(tradeId, buyOrder.sku_id, buyOrder.id, sellOrder.id, buyOrder.user_id, sellOrder.user_id, leg.quantity, leg.executionPrice, buyerFeeAmount, sellerFeeAmount, buyerFundsHoldId, sellerInventoryHoldId, sellerDepositHoldId, leg.quantity, leg.ruleVersion, fulfillmentDeadline, now, now);

    // I20B：撮合成功后投递到期回收任务（uniqueKey 去重，重复投递不会产生多行 job）。
    this.enqueueOrderExpire({ kind: "trade", id: tradeId, runAfter: fulfillmentDeadline });

    this.users.writeEconomicAudit(buyOrder.user_id, "bilateral_order.matched", "bilateral_trade", tradeId, requestId, { skuId: buyOrder.sku_id, side: "buy", buyOrderId: buyOrder.id, sellOrderId: sellOrder.id, quantity: leg.quantity, executionPrice: leg.executionPrice, buyerFee: buyerFeeAmount, ruleVersion: leg.ruleVersion, buyerFundsHoldId, fulfillmentDeadline }, now);
    this.users.writeEconomicAudit(sellOrder.user_id, "bilateral_order.matched", "bilateral_trade", tradeId, requestId, { skuId: sellOrder.sku_id, side: "sell", buyOrderId: buyOrder.id, sellOrderId: sellOrder.id, quantity: leg.quantity, executionPrice: leg.executionPrice, sellerFee: sellerFeeAmount, ruleVersion: leg.ruleVersion, sellerInventoryHoldId, sellerDepositHoldId, fulfillmentDeadline }, now);

    return this.findTradeRow(tradeId) ?? null;
  }

  private selectTradeSql(): string {
    return "SELECT id, sku_id, buy_order_id, sell_order_id, buyer_user_id, seller_user_id, quantity, execution_price_amount, buyer_fee_amount, seller_fee_amount, rule_version, status, fulfillment_deadline, created_at, updated_at FROM bilateral_trades";
  }

  private findTradeRow(tradeId: string): TradeRow | undefined {
    return this.database.prepare(`${this.selectTradeSql()} WHERE id = ?`).get(tradeId) as TradeRow | undefined;
  }

  /** I20B 履约/取消/到期用例读取完整成交行（含 holdIds 与卖方单位保证金/库存数量）。 */
  private selectFullTradeSql(): string {
    return "SELECT t.id, t.sku_id, t.buy_order_id, t.sell_order_id, t.buyer_user_id, t.seller_user_id, t.quantity, t.execution_price_amount, t.buyer_fee_amount, t.seller_fee_amount, t.buyer_funds_hold_id, t.seller_inventory_hold_id, t.seller_deposit_hold_id, t.seller_inventory_quantity, t.rule_version, t.status, t.fulfillment_deadline, t.created_at, t.updated_at, s.unit_fulfillment_deposit_amount AS sell_unit_fulfillment_deposit_amount FROM bilateral_trades t JOIN bilateral_orders s ON s.id = t.sell_order_id";
  }

  private findFullTradeRow(tradeId: string): FullTradeRow | undefined {
    return this.database.prepare(`${this.selectFullTradeSql()} WHERE t.id = ?`).get(tradeId) as FullTradeRow | undefined;
  }

  /**
   * I20B 取消履约的核心资产恢复逻辑，玩家取消与到期回收共用：退回买方资金、扣除卖方保证金、
   * 恢复卖方库存，并把成交推进为 cancelled（条件 UPDATE）。无幂等键（由调用方在外层事务包裹）。
   */
  private applyTradeCancellation(trade: FullTradeRow, requestId: string, now: string, auditAction: string): void {
    // 买方资金退回：releaseFunds 把待履约资金 hold 退回 available。
    if (trade.buyer_funds_hold_id) {
      const released = this.users.releaseOrderFunds(trade.buyer_user_id, trade.buyer_funds_hold_id, now);
      if (released === "not-active") throw new Error(`取消履约买方资金退回失败：hold ${trade.buyer_funds_hold_id} 非活跃，事务回滚`);
    }
    // 卖方保证金扣除：captureFunds 释放并扣除保证金 hold，写 debit 账本。
    if (trade.seller_deposit_hold_id) {
      const captured = this.users.funds().captureFunds(trade.seller_user_id, trade.seller_deposit_hold_id, now, `${P2P_DEPOSIT_FORFEITED_CORRELATION_PREFIX}:${trade.id}`);
      if (captured === "not-active") throw new Error(`取消履约卖方保证金扣除失败：hold ${trade.seller_deposit_hold_id} 非活跃，事务回滚`);
    }
    // 卖方库存恢复：把撮合时已 capture 离开持有的数量加回 quantity/available。
    this.inventory.restorePartialInLedgerTransaction({
      userId: trade.seller_user_id,
      skuId: trade.sku_id,
      quantity: trade.seller_inventory_quantity,
      correlationId: trade.id,
      now
    });

    const advanced = this.database.prepare(
      "UPDATE bilateral_trades SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'matched_pending_fulfillment'"
    ).run(now, trade.id);
    if (advanced.changes !== 1) throw new Error(`取消履约成交状态迁移冲突：trade=${trade.id}，事务回滚`);

    this.users.writeEconomicAudit(trade.buyer_user_id, auditAction, "bilateral_trade", trade.id, requestId, {
      skuId: trade.sku_id, role: "buyer", quantity: trade.quantity, executionPrice: trade.execution_price_amount,
      buyerFee: trade.buyer_fee_amount, sellerFee: trade.seller_fee_amount, ruleVersion: trade.rule_version,
      buyerFundsHoldId: trade.buyer_funds_hold_id, fulfillmentDeadline: trade.fulfillment_deadline
    }, now);
    this.users.writeEconomicAudit(trade.seller_user_id, auditAction, "bilateral_trade", trade.id, requestId, {
      skuId: trade.sku_id, role: "seller", quantity: trade.quantity, executionPrice: trade.execution_price_amount,
      buyerFee: trade.buyer_fee_amount, sellerFee: trade.seller_fee_amount, ruleVersion: trade.rule_version,
      sellerInventoryHoldId: trade.seller_inventory_hold_id, sellerDepositHoldId: trade.seller_deposit_hold_id,
      restoredInventoryQuantity: trade.seller_inventory_quantity, fulfillmentDeadline: trade.fulfillment_deadline
    }, now);
  }

  /** I20B 到期委托释放剩余资金/库存/保证金预占（与撤单释放同语义，但写 expired 审计）。 */
  private releaseOrderReservedFunds(row: OrderRow, now: string): void {
    if (row.reserved_funds_hold_id) {
      const released = this.users.releaseOrderFunds(row.user_id, row.reserved_funds_hold_id, now);
      if (released === "not-active") throw new Error(`到期委托资金释放失败：hold ${row.reserved_funds_hold_id} 非活跃，事务回滚`);
    }
    if (row.inventory_hold_id) {
      const released = this.inventory.release({ userId: row.user_id, holdId: row.inventory_hold_id, correlationId: row.id, now });
      if (released === "not-active") throw new Error(`到期委托库存释放失败：hold ${row.inventory_hold_id} 非活跃，事务回滚`);
    }
  }

  /** I20B 写入 p2p.trade.settled 事实事件 + outbox + 重定价任务；market-service 按 liquidity 消费一次 quantity。 */
  private writeP2pTradeSettledEvent(trade: FullTradeRow, now: string): string {
    const eventId = randomUUID();
    const event = {
      id: eventId,
      type: "p2p.trade.settled" as const,
      version: 1 as const,
      occurredAt: now,
      correlationId: trade.id,
      payload: {
        tradeId: trade.id, skuId: trade.sku_id, side: "p2p" as const, quantity: trade.quantity,
        executionPrice: { amount: trade.execution_price_amount, currency: "GAME_CREDIT" as const },
        buyerFee: { amount: trade.buyer_fee_amount, currency: "GAME_CREDIT" as const },
        sellerFee: { amount: trade.seller_fee_amount, currency: "GAME_CREDIT" as const },
        ruleVersion: trade.rule_version
      }
    };
    this.database.prepare(
      "INSERT INTO fact_events (id, event_type, aggregate_type, aggregate_id, version, payload_json, occurred_at) VALUES (?, 'p2p.trade.settled', 'bilateral_trade', ?, 1, ?, ?)"
    ).run(eventId, trade.id, JSON.stringify(event), now);
    this.database.prepare(
      "INSERT INTO outbox (id, event_id, destination, payload_json, status, created_at, dispatched_at) VALUES (?, ?, 'market.fact-event', ?, 'pending', ?, NULL)"
    ).run(randomUUID(), eventId, JSON.stringify(event), now);
    enqueueMarketRepriceJob(this.database, `fact-event:${eventId}`, now);
    return eventId;
  }

  /** I20B 投递 order.expire 任务（uniqueKey 去重，重复投递不产生多行 job）。须在外层事务内调用。 */
  private enqueueOrderExpire(input: { kind: "order" | "trade"; id: string; runAfter: string }): void {
    const uniqueKey = input.kind === "order" ? `${ORDER_EXPIRE_TASK_PREFIX.order}:${input.id}` : `${ORDER_EXPIRE_TASK_PREFIX.trade}:${input.id}`;
    enqueueOrderExpireJob(this.database, uniqueKey, input.runAfter, { kind: input.kind, id: input.id }, input.runAfter);
  }

  private tradeIdempotencyResult(existing: IdempotencyRow, fingerprint: string): TradeCommandResult {
    if (existing.request_fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.status !== "completed" || !existing.response_status || !existing.response_json) return { state: "in-progress" };
    return { state: "replayed", statusCode: existing.response_status, response: JSON.parse(existing.response_json) as ApiResponse<TradeCommandResponse> };
  }

  private tradeFail(input: { userId: string; idempotencyKey: string; requestId: string }, now: string, statusCode: number, code: ApiErrorCode, message: string): TradeCommandResult {
    const response = failure(input.requestId, code, message);
    this.completeTradeIdempotency(input.userId, input.idempotencyKey, statusCode, response, now);
    return { state: "completed", statusCode, response };
  }

  private completeTradeIdempotency(actorId: string, key: string, statusCode: number, response: ApiResponse<TradeCommandResponse>, now: string): void {
    const updated = this.database.prepare(
      "UPDATE idempotency_requests SET status = 'completed', response_status = ?, response_json = ?, completed_at = ? WHERE actor_id = ? AND idempotency_key = ? AND status = 'running'"
    ).run(statusCode, JSON.stringify(response), now, actorId, key);
    if (updated.changes !== 1) throw new Error("履约/取消幂等请求状态损坏");
  }

  private toTradeDto(row: TradeRow): BilateralTradeDto {
    return {
      id: row.id,
      skuId: row.sku_id,
      buyOrderId: row.buy_order_id,
      sellOrderId: row.sell_order_id,
      buyerUserId: row.buyer_user_id,
      sellerUserId: row.seller_user_id,
      quantity: row.quantity,
      executionPrice: money(row.execution_price_amount),
      buyerFee: money(row.buyer_fee_amount),
      sellerFee: money(row.seller_fee_amount),
      ruleVersion: row.rule_version,
      fulfillmentDeadline: row.fulfillment_deadline,
      status: row.status as BilateralTradeDto["status"],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  /** I19F 玩家成交查询读取卖方待履约库存数量与卖方单位保证金；不读取 holdId（不返回给浏览器）。 */
  private selectPlayerTradeSql(): string {
    return "SELECT t.id, t.sku_id, t.buy_order_id, t.sell_order_id, t.buyer_user_id, t.seller_user_id, t.quantity, t.execution_price_amount, t.buyer_fee_amount, t.seller_fee_amount, t.seller_inventory_quantity, t.rule_version, t.status, t.fulfillment_deadline, t.created_at, t.updated_at, s.unit_fulfillment_deposit_amount AS sell_unit_fulfillment_deposit_amount FROM bilateral_trades t JOIN bilateral_orders s ON s.id = t.sell_order_id";
  }

  /** 把成交行投影为玩家视角 DTO：只返回当前玩家自己的委托 ID、角色与待履约资产，脱敏对手。 */
  private toPlayerTradeDto(row: PlayerTradeRow, userId: string): PlayerBilateralTradeDto {
    const isBuyer = row.buyer_user_id === userId;
    // 买方待履约资金 = 数量×成交价 + 买方已成交 order_fee；卖方待履约资金 = 已成交保证金（单位保证金×数量）。
    const pendingFundsAmount = isBuyer
      ? row.quantity * row.execution_price_amount + row.buyer_fee_amount
      : row.sell_unit_fulfillment_deposit_amount * row.quantity;
    return {
      id: row.id,
      skuId: row.sku_id,
      role: isBuyer ? "buyer" : "seller",
      myOrderId: isBuyer ? row.buy_order_id : row.sell_order_id,
      quantity: row.quantity,
      executionPrice: money(row.execution_price_amount),
      fee: money(isBuyer ? row.buyer_fee_amount : row.seller_fee_amount),
      pendingFunds: money(pendingFundsAmount),
      pendingInventoryQuantity: isBuyer ? null : row.seller_inventory_quantity,
      ruleVersion: row.rule_version,
      fulfillmentDeadline: row.fulfillment_deadline,
      status: row.status as PlayerBilateralTradeDto["status"],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
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

/** I20B 履约/取消履约请求指纹：请求体为空，指纹仅依赖 tradeId 与 action，确保同键同参重放。 */
export function orderTradeRequestFingerprint(input: { tradeId: string; action: "fulfill" | "cancel" }): string {
  return createHash("sha256").update(canonicalizeRequest(input)).digest("hex");
}
