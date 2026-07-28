import type { OrderStatus } from "@mtg-market/contracts";

/**
 * I18B 双边委托与 I19B 撮合领域常量与不变量。撮合把已成交部分的买方资金、卖方库存/保证金
 * 从预占转为待履约持有并写成交记录；模拟履约、p2p.trade.settled、取消履约与到期在 I20B/I22B 接入。
 * 本期状态机允许 open/partially_filled → partially_filled|matched_pending_fulfillment（撮合）或 cancelled（撤单）。
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

/** 买方待履约资金 fund_holds.reason：撮合把已成交部分从 order_buy 预占转为待履约持有。 */
export const ORDER_FULFILLMENT_FUND_HOLD_REASON = "order_fulfillment";

/** 卖单保证金 fund_holds.reason；卖单创建与撮合切分均使用同一 reason。 */
export const ORDER_FULFILLMENT_DEPOSIT_HOLD_REASON = "order_fulfillment_deposit";

/** 撮合触发（系统 actor）的幂等请求 actor 前缀；与玩家 Idempotency-Key 分隔。 */
export const MATCH_SYSTEM_ACTOR_PREFIX = "system:match";

export function isCancellable(status: OrderStatus): boolean {
  return CANCELLABLE_ORDER_STATUSES.has(status);
}

export function isActiveOrder(status: OrderStatus): boolean {
  return ACTIVE_ORDER_STATUSES.has(status);
}

export function isMatchable(status: OrderStatus): boolean {
  return MATCHABLE_ORDER_STATUSES.has(status);
}

export function assertPositiveQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new RangeError("委托数量必须为正整数");
}
