/** I34B（E12）：Watchlist 目标价提醒的领域不变量与纯判定函数。 */
export const WATCHLIST_RULE_VERSION = "watchlist/v1" as const;
/** 每玩家 Watchlist 条目上限，与迁移 `watchlist_limits` 单例默认值一致。 */
export const WATCHLIST_MAX_ITEMS_PER_USER = 50;

export type WatchlistTargetType = "game_price" | "reference_price";
export type WatchlistDirection = "at_or_below" | "at_or_above";

/**
 * 命中判定：目标价（整数最小货币单位）与当前最新报价比较。
 * - at_or_below：最新价 <= 目标价（跌至目标价即提醒）
 * - at_or_above：最新价 >= 目标价（涨至目标价即提醒）
 * 仅做整数比较，不引入浮点；命中与否可重放。
 */
export function hitWatchlistTarget(direction: WatchlistDirection, currentPrice: number, targetAmount: number): boolean {
  if (!Number.isSafeInteger(currentPrice) || currentPrice < 0 || !Number.isSafeInteger(targetAmount) || targetAmount < 0) {
    throw new RangeError("Watchlist 命中判定的价格与目标价必须为非负安全整数");
  }
  return direction === "at_or_below" ? currentPrice <= targetAmount : currentPrice >= targetAmount;
}
