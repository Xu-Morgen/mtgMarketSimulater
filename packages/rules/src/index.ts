export interface NpcQuoteInput {
  referencePrice: number;
  marketFactor: number;
  buySpread: number;
  sellSpread: number;
}

/** I07 初始资金规则：金额为整数最小单位，规则版本会写入每一份新存档。 */
export const INITIAL_FUNDING_RULE_VERSION = "v1" as const;
export const INITIAL_FUNDING = { amount: 10_000, currency: "GAME_CREDIT" as const };

export function resolveInitialFunding(version: string): typeof INITIAL_FUNDING {
  if (version !== INITIAL_FUNDING_RULE_VERSION) {
    throw new RangeError(`不支持的初始资金规则版本：${version}`);
  }
  return INITIAL_FUNDING;
}

export function calculateNpcQuote(input: NpcQuoteInput) {
  const mid = roundCurrency(input.referencePrice * input.marketFactor);

  return {
    referencePrice: input.referencePrice,
    marketPrice: mid,
    npcBuyPrice: roundCurrency(mid * (1 - input.buySpread)),
    npcSellPrice: roundCurrency(mid * (1 + input.sellSpread))
  };
}

function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}
