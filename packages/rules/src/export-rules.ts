/**
 * I31B 玩家经营报表导出纯规则。所有导出字段顺序与 CSV 单元格转义（含公式注入防护）
 * 均在此以纯函数实现：显式版本、显式输入、可重放、不依赖数据库、HTTP、时间或随机源。
 * API 的 ExportApplication 负责从 SQLite 读取数据并调用这些函数生成稳定字段与安全 CSV。
 */

export const EXPORT_RULES_VERSION = "export/v1" as const;

/** 各报表稳定列顺序；字段顺序在规则版本内冻结，保证导出列稳定（I31B 验收“稳定字段”）。 */
export type ExportReportKind =
  | "holdings"
  | "ledger"
  | "npcTrades"
  | "p2pOrders"
  | "p2pTrades"
  | "packOpenings"
  | "tournaments";

const HOLDINGS_COLUMNS = ["skuId", "cardName", "setCode", "setName", "collectorNumber", "finish", "quantity", "availableQuantity", "orderLockedQuantity", "tournamentLockedQuantity", "averageCostAmount", "marketValueAmount", "marketValueUnavailableReason", "updatedAt"] as const;
const LEDGER_COLUMNS = ["id", "direction", "amount", "balanceAfter", "reason", "correlationId", "occurredAt"] as const;
const NPC_TRADES_COLUMNS = ["id", "skuId", "side", "unitPriceAmount", "unitFeeAmount", "totalAmount", "quantity", "settlementDate", "createdAt"] as const;
const P2P_ORDERS_COLUMNS = ["id", "side", "skuId", "status", "originalQuantity", "remainingQuantity", "filledQuantity", "limitPriceAmount", "unitFeeAmount", "expiresAt", "createdAt"] as const;
const P2P_TRADES_COLUMNS = ["id", "role", "skuId", "quantity", "executionPriceAmount", "totalAmount", "feeAmount", "status", "createdAt"] as const;
const PACK_OPENINGS_COLUMNS = ["id", "packId", "packRuleVersion", "spentAmount", "drawnSkus", "createdAt"] as const;
const TOURNAMENTS_COLUMNS = ["kind", "registrationId", "tournamentId", "status", "rank", "points", "rewardAmount", "settledAt", "registeredAt"] as const;

/** 返回某报表的稳定列顺序（只读数组）；未知报表抛错，保证规则可重放且无静默回退。 */
export function stableColumnOrder(kind: ExportReportKind): readonly string[] {
  switch (kind) {
    case "holdings": return HOLDINGS_COLUMNS;
    case "ledger": return LEDGER_COLUMNS;
    case "npcTrades": return NPC_TRADES_COLUMNS;
    case "p2pOrders": return P2P_ORDERS_COLUMNS;
    case "p2pTrades": return P2P_TRADES_COLUMNS;
    case "packOpenings": return PACK_OPENINGS_COLUMNS;
    case "tournaments": return TOURNAMENTS_COLUMNS;
    default: {
      // 穷尽性检查：新增报表类型必须在此补全列序，否则规则拒绝运行。
      const exhaustive: never = kind;
      throw new RangeError(`未知导出报表类型：${String(exhaustive)}`);
    }
  }
}

/**
 * CSV 公式注入防护：单元格以 `= + - @` 或以 TAB/CR/LF 开头时前置单引号 `'`，
 * 含逗号、双引号或换行时用双引号包裹并把内部双引号转义为两个双引号。
 * null/undefined 输出为空字符串，不触发转义。返回的值可直接拼入 CSV 行。
 */
export function csvEscapeCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = typeof value === "string" ? value : String(value);
  let cell = raw;
  // 公式注入：以 = + - @ 开头时前置单引号，阻止电子表格把它当公式执行。
  if (raw.length > 0 && (raw[0] === "=" || raw[0] === "+" || raw[0] === "-" || raw[0] === "@")) {
    cell = `'${raw}`;
  }
  // 含分隔符或引号/换行时按 RFC 4180 用双引号包裹，内部双引号转义。
  if (cell.includes(",") || cell.includes('"') || cell.includes("\n") || cell.includes("\r") || cell.includes("\t")) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

/**
 * 把行对象按指定列序拼成一行 CSV（逗号分隔，单元格走 csvEscapeCell）。
 * 列不存在于行中时输出空单元格；多余字段忽略。保证列序与字段稳定。
 */
export function csvRow(row: Record<string, unknown>, columns: readonly string[]): string {
  return columns.map((column) => csvEscapeCell(row[column])).join(",");
}

/**
 * 把完整报表序列化为 CSV 文本：首行表头（列名，同样走 csvEscapeCell），其余每行一行数据。
 * 行内字段缺失输出空单元格；行对象可能含 columns 之外的字段，按列序只取所需字段。
 */
export function toCsv(rows: ReadonlyArray<Record<string, unknown>>, columns: readonly string[]): string {
  const header = columns.map((column) => csvEscapeCell(column)).join(",");
  const body = rows.map((row) => csvRow(row, columns)).join("\n");
  return body.length > 0 ? `${header}\n${body}` : header;
}
