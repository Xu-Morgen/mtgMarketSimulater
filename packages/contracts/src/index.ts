export type CurrencyCode = "EUR" | "GAME_CREDIT";

export type PriceSource = "mtgjson-cardmarket" | "manual-test";

export interface CardSku {
  id: string;
  scryfallId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  finish: "nonfoil" | "foil" | "etched";
  imagePath: string | null;
}

export interface PriceSnapshot {
  skuId: string;
  source: PriceSource;
  sourcePrice: number;
  currency: CurrencyCode;
  capturedAt: string;
}

export interface TournamentResult {
  tournamentId: string;
  playerId: string;
  opponentName: string;
  format: string;
  winner: "player" | "opponent";
  highlights: string[];
}

export interface NarrativePayload {
  headline: string;
  summary: string;
  highlights: string[];
  npcQuote: string;
  tone: "victory" | "defeat" | "tense" | "neutral";
}
