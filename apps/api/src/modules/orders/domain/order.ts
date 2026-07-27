import type { OrderStatus } from "@mtg-market/contracts";

/**
 * I18B 双边委托领域常量与不变量。撮合、模拟履约与到期在 I19B/I20B 接入；
 * 本期状态机只允许 open/partially_filled → cancelled。
 */

/** 订单阶段实际允许的取消前状态；其余状态（matched/fulfilled/cancelled/expired）不可撤。 */
export const CANCELLABLE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set(["open", "partially_filled"]);

/** 双边委托资金/库存预占的业务实体类型，供 fund_holds 与 inventory_holds 关联。 */
export const ORDER_HOLD_ENTITY_TYPE = "bilateral_order";

/** 撮合前的有效状态；订单簿与单日额度只统计这些状态下的剩余数量。 */
export const ACTIVE_ORDER_STATUSES: ReadonlySet<OrderStatus> = new Set(["open", "partially_filled"]);

export function isCancellable(status: OrderStatus): boolean {
  return CANCELLABLE_ORDER_STATUSES.has(status);
}

export function isActiveOrder(status: OrderStatus): boolean {
  return ACTIVE_ORDER_STATUSES.has(status);
}

export function assertPositiveQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new RangeError("委托数量必须为正整数");
}
