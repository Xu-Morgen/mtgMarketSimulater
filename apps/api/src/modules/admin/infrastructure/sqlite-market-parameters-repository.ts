import type Database from "better-sqlite3";
import type { AdminMarketParametersDto } from "@mtg-market/contracts";

/** I30B 市场参数单例仓储；管理员可预览并经版本条件更新，更新后投递 market.reprice。 */
export interface MarketParametersRow {
  rule_version: string;
  eur_cent_to_game_credit_bps: number;
  minimum_price: number;
  npc_buy_spread_bps: number;
  npc_sell_spread_bps: number;
  npc_fee_bps: number;
  /** I34B：NPC 做市商倾向全局因素（5000–20000 bp），reprice 时写入报价 reason。 */
  npc_bias_bps: number;
  npc_bias_reason: string;
  updated_at: string;
  /** 乐观版本号，每次更新自增；用于并发冲突检测。 */
  version: number;
}

export interface UpdateMarketParametersInput {
  eurCentToGameCreditBps: number;
  minimumPrice: number;
  npcBuySpreadBps: number;
  npcSellSpreadBps: number;
  npcFeeBps: number;
  npcBiasBps: number;
  npcBiasReason: string;
  expectedVersion: number;
  now: string;
}

export class SqliteMarketParametersRepository {
  constructor(private readonly database: Database.Database) {}

  get(): MarketParametersRow | null {
    const row = this.database
      .prepare(
        "SELECT rule_version, eur_cent_to_game_credit_bps, minimum_price, npc_buy_spread_bps, npc_sell_spread_bps, npc_fee_bps, npc_bias_bps, npc_bias_reason, updated_at, version FROM market_parameters WHERE singleton = 1"
      )
      .get() as MarketParametersRow | undefined;
    return row ?? null;
  }

  toDto(row: MarketParametersRow): AdminMarketParametersDto {
    return {
      ruleVersion: row.rule_version,
      eurCentToGameCreditBps: row.eur_cent_to_game_credit_bps,
      minimumPrice: row.minimum_price,
      npcBuySpreadBps: row.npc_buy_spread_bps,
      npcSellSpreadBps: row.npc_sell_spread_bps,
      npcFeeBps: row.npc_fee_bps,
      npcBiasBps: row.npc_bias_bps,
      npcBiasReason: row.npc_bias_reason,
      version: row.version,
      updatedAt: row.updated_at
    };
  }

  /** 条件更新：expectedVersion 不匹配返回 "stale"，成功后 version 自增。调用方须处于事务内。 */
  update(input: UpdateMarketParametersInput): MarketParametersRow | "stale" {
    const result = this.database
      .prepare(
        "UPDATE market_parameters SET eur_cent_to_game_credit_bps = ?, minimum_price = ?, npc_buy_spread_bps = ?, npc_sell_spread_bps = ?, npc_fee_bps = ?, npc_bias_bps = ?, npc_bias_reason = ?, updated_at = ?, version = version + 1 WHERE singleton = 1 AND version = ?"
      )
      .run(input.eurCentToGameCreditBps, input.minimumPrice, input.npcBuySpreadBps, input.npcSellSpreadBps, input.npcFeeBps, input.npcBiasBps, input.npcBiasReason, input.now, input.expectedVersion);
    if (result.changes !== 1) return "stale";
    return this.get()!;
  }
}
