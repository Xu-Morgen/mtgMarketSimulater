import type { Money } from "@mtg-market/contracts";

/** 金额由服务端以最小单位给出；这里只负责展示，绝不参与结算或汇总。 */
export function formatMoney(money: Money): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(money.amount) + " 游戏币";
}
