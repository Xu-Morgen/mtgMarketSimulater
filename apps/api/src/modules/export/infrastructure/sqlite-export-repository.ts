import type Database from "better-sqlite3";
import type { ExportReportKind } from "@mtg-market/rules";

/**
 * I31B 玩家经营报表只读仓储。所有查询严格以 user_id = ? 参数化过滤，
 * 绝不读取或泄露其他玩家数据；这是用户隔离的核心防线。
 * 返回行对象按导出规则包的稳定列序字段命名，便于 toCsv / JSON 序列化。
 */
export class SqliteExportRepository {
  constructor(private readonly database: Database.Database) {}

  /** 库存持仓：JOIN 卡牌名称，只取该玩家。 */
  holdings(userId: string): Array<Record<string, unknown>> {
    return this.database.prepare(
      `SELECT h.sku_id AS skuId, p.name AS cardName, s.code AS setCode, s.name AS setName,
              p.collector_number AS collectorNumber, sku.finish AS finish,
              h.quantity, h.available_quantity AS availableQuantity,
              h.order_locked_quantity AS orderLockedQuantity,
              h.tournament_locked_quantity AS tournamentLockedQuantity,
              h.average_cost_amount AS averageCostAmount,
              h.market_value_amount AS marketValueAmount,
              CASE WHEN h.market_value_amount IS NULL THEN 'no_snapshot' ELSE NULL END AS marketValueUnavailableReason,
              h.updated_at AS updatedAt
       FROM inventory_holdings h
       JOIN card_skus sku ON sku.id = h.sku_id
       JOIN card_printings p ON p.id = sku.printing_id
       JOIN card_sets s ON s.id = p.set_id
       WHERE h.user_id = ?
       ORDER BY h.updated_at DESC`
    ).all(userId) as Array<Record<string, unknown>>;
  }

  /** 资金账本：经 accounts 关联到玩家，含币种。 */
  ledger(userId: string): Array<Record<string, unknown>> {
    return this.database.prepare(
      `SELECT l.id, l.direction, l.amount, l.balance_after AS balanceAfter,
              l.reason, l.correlation_id AS correlationId, l.occurred_at AS occurredAt
       FROM ledger_entries l
       JOIN accounts a ON a.id = l.account_id
       WHERE a.user_id = ?
       ORDER BY l.occurred_at DESC, l.id DESC`
    ).all(userId) as Array<Record<string, unknown>>;
  }

  /** NPC 交易：玩家买卖记录。 */
  npcTrades(userId: string): Array<Record<string, unknown>> {
    return this.database.prepare(
      `SELECT id, sku_id AS skuId, side, unit_price_amount AS unitPriceAmount,
              unit_fee_amount AS unitFeeAmount, total_amount AS totalAmount,
              quantity, settlement_date AS settlementDate, created_at AS createdAt
       FROM npc_trades
       WHERE user_id = ?
       ORDER BY created_at DESC`
    ).all(userId) as Array<Record<string, unknown>>;
  }

  /** P2P 委托：玩家创建的买卖单（含已成交数量 = original - remaining）。 */
  p2pOrders(userId: string): Array<Record<string, unknown>> {
    return this.database.prepare(
      `SELECT id, side, sku_id AS skuId, status,
              original_quantity AS originalQuantity,
              remaining_quantity AS remainingQuantity,
              (original_quantity - remaining_quantity) AS filledQuantity,
              limit_price_amount AS limitPriceAmount,
              unit_fee_amount AS unitFeeAmount,
              expires_at AS expiresAt, created_at AS createdAt
       FROM bilateral_orders
       WHERE user_id = ?
       ORDER BY created_at DESC`
    ).all(userId) as Array<Record<string, unknown>>;
  }

  /** P2P 成交：玩家作为买方或卖方的成交记录，附加 role 列。 */
  p2pTrades(userId: string): Array<Record<string, unknown>> {
    return this.database.prepare(
      `SELECT id, CASE WHEN buyer_user_id = ? THEN 'buy' ELSE 'sell' END AS role,
              sku_id AS skuId, quantity, execution_price_amount AS executionPriceAmount,
              execution_price_amount * quantity AS totalAmount,
              CASE WHEN buyer_user_id = ? THEN buyer_fee_amount ELSE seller_fee_amount END AS feeAmount,
              status, created_at AS createdAt
       FROM bilateral_trades
       WHERE buyer_user_id = ? OR seller_user_id = ?
       ORDER BY created_at DESC`
    ).all(userId, userId, userId, userId) as Array<Record<string, unknown>>;
  }

  /** 开包记录：解析 result_summary_json 中的抽取 SKU。 */
  packOpenings(userId: string): Array<Record<string, unknown>> {
    const rows = this.database.prepare(
      `SELECT id, pack_id AS packId, pack_rule_version AS packRuleVersion,
              spent_amount AS spentAmount, result_summary_json AS resultSummaryJson,
              created_at AS createdAt
       FROM pack_openings
       WHERE user_id = ?
       ORDER BY created_at DESC`
    ).all(userId) as Array<{ id: string; packId: string; packRuleVersion: string; spentAmount: number; resultSummaryJson: string; createdAt: string }>;
    return rows.map((row) => {
      let drawnSkus = "";
      try {
        const parsed = JSON.parse(row.resultSummaryJson) as { cards?: Array<{ skuId?: string }> };
        drawnSkus = (parsed.cards ?? []).map((card) => card.skuId ?? "").filter(Boolean).join(" ");
      } catch {
        drawnSkus = "";
      }
      return { id: row.id, packId: row.packId, packRuleVersion: row.packRuleVersion, spentAmount: row.spentAmount, drawnSkus, createdAt: row.createdAt };
    });
  }

  /** 比赛记录：NPC 日赛 + 玩家创建赛事，玩家参与的报名、结果与奖励。 */
  tournaments(userId: string): Array<Record<string, unknown>> {
    const npc = this.database.prepare(
      `SELECT 'npc' AS kind, r.id AS registrationId, r.tournament_id AS tournamentId,
              r.status, res.rank, COALESCE(res.points, 0) AS points,
              COALESCE(res.reward_amount, 0) AS rewardAmount,
              res.settled_at AS settledAt, r.registered_at AS registeredAt
       FROM tournament_registrations r
       LEFT JOIN tournament_results res ON res.registration_id = r.id
       WHERE r.user_id = ?`
    ).all(userId) as Array<Record<string, unknown>>;
    const player = this.database.prepare(
      `SELECT 'player' AS kind, r.id AS registrationId, r.tournament_id AS tournamentId,
              r.status, res.rank, COALESCE(res.points, 0) AS points,
              COALESCE(res.reward_amount, 0) AS rewardAmount,
              res.settled_at AS settledAt, r.created_at AS registeredAt
       FROM player_tournament_registrations r
       LEFT JOIN player_tournament_results res ON res.registration_id = r.id
       WHERE r.user_id = ?`
    ).all(userId) as Array<Record<string, unknown>>;
    return npc.concat(player).sort((a, b) => {
      const av = String(a.registeredAt ?? "");
      const bv = String(b.registeredAt ?? "");
      return av < bv ? 1 : av > bv ? -1 : 0;
    });
  }

  /** 按报表类型读取，供 ExportService 统一调用。 */
  readReport(userId: string, kind: ExportReportKind): Array<Record<string, unknown>> {
    switch (kind) {
      case "holdings": return this.holdings(userId);
      case "ledger": return this.ledger(userId);
      case "npcTrades": return this.npcTrades(userId);
      case "p2pOrders": return this.p2pOrders(userId);
      case "p2pTrades": return this.p2pTrades(userId);
      case "packOpenings": return this.packOpenings(userId);
      case "tournaments": return this.tournaments(userId);
      default: return [];
    }
  }
}
