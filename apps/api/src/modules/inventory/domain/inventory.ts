import { assertMinorUnits } from "@mtg-market/database";

export type InventoryLockTarget = { reason: "order" | "tournament"; entityType: string; entityId: string };

/** 库存变更的最小输入：成本只在获得资产时影响移动平均成本。 */
export type InventoryAdjustment = {
  userId: string; skuId: string; quantityDelta: number; unitCostAmount?: number; reason: string; correlationId: string; now: string;
};

export function assertPositiveQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity <= 0) throw new RangeError("库存数量必须为正整数");
}

export function assertUnitCost(amount: number): void {
  assertMinorUnits(amount);
  if (amount < 0) throw new RangeError("库存成本不能为负数");
}

/** 移动平均成本只以整数最小单位计算；清仓后成本归零，卖出不重估剩余成本。 */
export function nextAverageCost(currentQuantity: number, currentAverageCost: number, quantityDelta: number, unitCostAmount?: number): number {
  if (quantityDelta > 0) {
    if (unitCostAmount === undefined) throw new RangeError("入库必须提供单位成本");
    assertUnitCost(unitCostAmount);
    return Math.floor((currentQuantity * currentAverageCost + quantityDelta * unitCostAmount) / (currentQuantity + quantityDelta));
  }
  const nextQuantity = currentQuantity + quantityDelta;
  if (nextQuantity < 0) throw new RangeError("库存不足");
  return nextQuantity === 0 ? 0 : currentAverageCost;
}
