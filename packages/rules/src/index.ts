export interface NpcQuoteInput {
  referencePrice: number;
  marketFactor: number;
  buySpread: number;
  sellSpread: number;
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
