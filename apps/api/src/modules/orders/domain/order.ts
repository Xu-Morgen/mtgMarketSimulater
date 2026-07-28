import type { BilateralTradeStatus, OrderStatus } from "@mtg-market/contracts";

/**
 * I18B 双边委托、I19B 撮合与 I20B 模拟履约的领域常量与不变量。撮合把已成交部分的买方资金、
 * 卖方库存/保证金从预占转为待履约持有并写成交记录；I20B 履约把成交推进为 fulfilled 并结算
 * 买方扣款/库存转入、卖方收入/保证金返还与 p2p.trade.settled 事实事件；取消履约与到期把成交
 * 推进为 cancelled 并退回买方资金、扣除卖方保证金、恢复卖方库存，不写 p2p.trade.settled。
 * 委托状态机：open/partially_filled → partially_filled|matched_pending_fulfillment（撮合）或
 * cancelled（撤单）或 expired（order.expire）；成交状态机：matched_pending_fulfillment → fulfilled|cancelled。
 */

/** 订单阶段实际允许的取消前状态；其余状态（matched/fulfilled/cancelled/expired）不可撤。 */
export const CANCELLABLE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set(["open", "partially_filled"]);

/** 双边委托资金/库存预占的业务实体类型，供 fund_holds 与 inventory_holds 关联。 */
export const ORDER_HOLD_ENTITY_TYPE = "bilateral_order";

/** I19B 成交记录的业务实体类型，供 fund_holds 关联买方待履约资金与卖方待履约保证金。 */
export const BILATERAL_TRADE_ENTITY_TYPE = "bilateral_trade";

/** 撮合后的有效状态；订单簿只统计这些状态下的剩余数量。 */
export const ACTIVE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set(["open", "partially_filled"]);

/** 可参与撮合的订单状态；matched/fulfilled/cancelled/expired 不再进入撮合输入。 */
export const MATCHABLE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set(["open", "partially_filled"]);

/** I20B 可被 order.expire 回收为 expired 的委托状态；matched 委托的待履约资产由成交到期任务处理。 */
export const EXPIRABLE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set(["open", "partially_filled"]);

/** I20B 可确认履约的成交状态；fulfilled/cancelled 不可再履约。 */
export const FULFILLABLE_TRADE_STATUSES: ReadonlySet<BilateralTradeStatus> = new Set(["matched_pending_fulfillment"]);

/** I20B 可取消履约的成交状态；fulfilled/cancelled 不可再取消。 */
export const CANCELLABLE_TRADE_STATUSES: ReadonlySet<BilateralTradeStatus> = new Set(["matched_pending_fulfillment"]);

/** 买方待履约资金 fund_holds.reason：撮合把已成交部分从 order_buy 预占转为待履约持有。 */
export const ORDER_FULFILLMENT_FUND_HOLD_REASON = "order_fulfillment";

/** 卖单保证金 fund_holds.reason；卖单创建与撮合切分均使用同一 reason。 */
export const ORDER_FULFILLMENT_DEPOSIT_HOLD_REASON = "order_fulfillment_deposit";

/** I20B 履约时买方扣款的账本 reason；与 NPC 买入一致便于报表聚合。 */
export const P2P_BUY_LEDGER_REASON = "p2p_buy";

/** I20B 履约时卖方收入的账本 reason；与 NPC 卖出一致便于报表聚合。 */
export const P2P_SELL_LEDGER_REASON = "p2p_sell";

/**
 * I20B 取消履约时卖方保证金扣除的账本 reason；只出现在取消路径，履约路径返还保证金。
 * 注意：captureFunds 仓库实际写入的账本 reason 取自 hold.reason（撮合时为
 * ORDER_FULFILLMENT_DEPOSIT_HOLD_REASON='order_fulfillment_deposit'）；此处仅作为取消
 * 路径的语义标识与 correlation_id 前缀使用，便于审计与对账按取消场景聚合。
 */
export const P2P_DEPOSIT_FORFEITED_CORRELATION_PREFIX = "p2p-deposit-forfeited";

/** I20B 取消履约恢复卖方库存的库存流水 reason；对应撮合时的部分捕获（离开持有）。 */
export const ORDER_RESTORED_INVENTORY_REASON = "order_restored";

/** 撮合触发（系统 actor）的幂等请求 actor 前缀；与玩家 Idempotency-Key 分隔。 */
export const MATCH_SYSTEM_ACTOR_PREFIX = "system:match";

/** order.expire 任务 uniqueKey 前缀；创建委托/撮合成交时投递，到期回收委托或成交。 */
export const ORDER_EXPIRE_TASK_PREFIX = {
  order: "order-expire",
  trade: "trade-expire"
} as const;

export function isCancellable(status: OrderStatus): boolean {
  return CANCELLABLE_ORDER_STATUSES.has(status);
}

export function isActiveOrder(status: OrderStatus): boolean {
  return ACTIVE_ORDER_STATUSES.has(status);
}

export function isMatchable(status: OrderStatus): boolean {
  return MATCHABLE_ORDER_STATUSES.has(status);
}

/** I20B：委托是否可被 order.expire 回收为 expired（仅未撮合完的挂单）。 */
export function isExpirableOrder(status: OrderStatus): boolean {
  return EXPIRABLE_ORDER_STATUSES.has(status);
}

/** I20B：成交是否可确认履约。 */
export function isFulfillableTrade(status: BilateralTradeStatus): boolean {
  return FULFILLABLE_TRADE_STATUSES.has(status);
}

/** I20B：成交是否可取消履约。 */
export function isCancellableTrade(status: BilateralTradeStatus): boolean {
  return CANCELLABLE_TRADE_STATUSES.has(status);
}

export function assertPositiveQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new RangeError("委托数量必须为正整数");
}
