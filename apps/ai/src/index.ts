import type { TournamentResult } from "@mtg-market/contracts";
import { narrativeSchema, type Narrative } from "./schema.js";

/**
 * AI 项目只接收已经结算的比赛摘要，返回经 Schema 校验的文本。
 * 经济系统不能调用此模块来决定胜负、奖励、库存或价格。
 */
export interface NarrativeProvider {
  createNarrative(result: TournamentResult): Promise<unknown>;
}

export async function generateNarrative(
  provider: NarrativeProvider,
  result: TournamentResult
): Promise<Narrative> {
  const output = await provider.createNarrative(result);
  return narrativeSchema.parse(output);
}

export function createFallbackNarrative(result: TournamentResult): Narrative {
  const won = result.winner === "player";
  return {
    headline: won ? "赛事告捷" : "下一战会更好",
    summary: `${result.format}赛事已经由规则引擎结算。${won ? "你的卡组拿下了这场对局。" : "这场对局留下了可调整的空间。"}`,
    highlights: result.highlights.slice(0, 3),
    npcQuote: won ? "这套牌的节奏相当漂亮。" : "记住这场对局，下次再来。",
    tone: won ? "victory" : "defeat"
  };
}
