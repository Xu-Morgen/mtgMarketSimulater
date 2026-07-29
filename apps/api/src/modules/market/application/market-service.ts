import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { calculateMarketQuote, marketQuoteValidUntil, MARKET_RULE_VERSION, propagateMarketPressure, type MarketFactorInput } from "@mtg-market/rules";
import type { MarketIndexHistoryDto, MarketIndexHistoryPointDto, MarketQuoteListItemDto, Page, PriceHistoryDto, PriceHistoryPointDto, PriceHistoryRange, QuoteDto } from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";

type ParametersRow = { rule_version: string; eur_cent_to_game_credit_bps: number; minimum_price: number; npc_buy_spread_bps: number; npc_sell_spread_bps: number; npc_fee_bps: number };
type SnapshotRow = { id: string; sku_id: string; price_amount: number; captured_at: string; source_version: string; set_id: string };
type MarketReason = NonNullable<QuoteDto["reasons"]>[number];
type QuoteRow = { id: string; sku_id: string; rule_version: string; reference_price_eur_cents: number; market_price_amount: number; npc_buy_price_amount: number; npc_sell_price_amount: number; npc_buy_fee_amount: number; npc_sell_fee_amount: number; calculated_at: string; valid_until: string; reasons_json: string };
type MarketListRow = QuoteRow & { name: string; set_code: string; set_name: string; collector_number: string; finish: "nonfoil" | "foil" | "etched"; rarity: string; tradable: number };
type FactRow = { id: string; event_type: string; payload_json: string };

export type MarketRepricePayload = { priceSyncRunId?: string; triggerKey?: string };
export type MarketQuoteFilters = {
  query?: string | undefined;
  setCode?: string | undefined;
  rarity?: string | undefined;
  finish?: "nonfoil" | "foil" | "etched" | undefined;
  tradable?: "any" | "tradable" | "untradable" | undefined;
  cursor?: string | undefined;
  limit: number;
};

/** 只供 Order application 结算使用的已持久化快照，避免订单模块直接读取市场表。 */
export type NpcSettlementQuote = {
  quoteId: string;
  skuId: string;
  quoteVersion: string;
  unitPriceAmount: number;
  unitFeeAmount: number;
  validUntil: string;
  tradable: boolean;
};

function asMoney(amount: number) { return { amount, currency: "GAME_CREDIT" as const }; }

/**
 * 市场应用层只读取已提交事实和外部快照，再物化本服报价投影。它从不修改外部快照、
 * 库存或经济流水；同一 triggerKey（按 UTC 自然日派生）的重放由报价唯一约束 `ON CONFLICT
 * (sku_id, trigger_key) DO UPDATE` 收敛为「同日只保留最新业务结果」——业务结果至多一次（按 SKU 维度）。
 */
export class MarketService {
  constructor(private readonly database: Database.Database) {}

  reprice(payload: MarketRepricePayload = {}, now = new Date().toISOString()): number {
    return withinTransaction(this.database, () => {
      const runId = payload.priceSyncRunId ?? this.latestSuccessfulRunId();
      if (!runId) return 0;
      // 默认 triggerKey 按本次 reprice 时刻的 UTC 自然日派生，与价格同步显式投递路径（price-sync:{completedAt 当日}）一致：
      // 报价新鲜度取决于「本日是否成功 reprice 过」，而非某次同步的 runId。
      const triggerKey = payload.triggerKey ?? `price-sync:${now.slice(0, 10)}`;
      const parameters = this.parameters();
      const snapshots = this.database.prepare(
        `SELECT entry.id, entry.sku_id, entry.price_amount, entry.captured_at, run.source_version, printing.set_id
         FROM price_snapshot_entries entry
         JOIN price_sync_runs run ON run.id = entry.sync_run_id
         JOIN card_skus sku ON sku.id = entry.sku_id
         JOIN card_printings printing ON printing.id = sku.printing_id
         WHERE entry.sync_run_id = ? AND entry.availability = 'priced' AND entry.price_amount IS NOT NULL`
      ).all(runId) as SnapshotRow[];
      const pressure = this.aggregateFactPressure();
      const validUntil = marketQuoteValidUntil(parameters.rule_version, now);
      let written = 0;
      for (const snapshot of snapshots) {
        const factors = this.factorsFor(snapshot, pressure, now);
        const result = calculateMarketQuote({
          version: parameters.rule_version,
          referencePriceEurCents: snapshot.price_amount,
          eurCentToGameCreditBasisPoints: parameters.eur_cent_to_game_credit_bps,
          minimumPrice: parameters.minimum_price,
          npcBuySpreadBasisPoints: parameters.npc_buy_spread_bps,
          npcSellSpreadBasisPoints: parameters.npc_sell_spread_bps,
          npcFeeBasisPoints: parameters.npc_fee_bps,
          factors
        });
        // ON CONFLICT(sku_id, trigger_key) DO UPDATE 覆盖全部业务字段：同日二次 reprice（triggerKey=price-sync:{UTC日}）
        // 会刷新价格、参数、reasons、calculated_at 与 valid_until，而非被首写挡住。业务结果至多一次——按 SKU 维度
        // 收敛为当日唯一一行的最新值；跨日因 triggerKey 不同而保留各自历史版本。
        const changed = this.database.prepare(
          `INSERT INTO market_quotes (id, sku_id, price_snapshot_entry_id, trigger_key, rule_version, reference_price_eur_cents,
            market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount,
            parameters_json, reasons_json, calculated_at, valid_until)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(sku_id, trigger_key) DO UPDATE SET
             price_snapshot_entry_id = excluded.price_snapshot_entry_id,
             rule_version = excluded.rule_version,
             reference_price_eur_cents = excluded.reference_price_eur_cents,
             market_price_amount = excluded.market_price_amount,
             npc_buy_price_amount = excluded.npc_buy_price_amount,
             npc_sell_price_amount = excluded.npc_sell_price_amount,
             npc_buy_fee_amount = excluded.npc_buy_fee_amount,
             npc_sell_fee_amount = excluded.npc_sell_fee_amount,
             parameters_json = excluded.parameters_json,
             reasons_json = excluded.reasons_json,
             calculated_at = excluded.calculated_at,
             valid_until = excluded.valid_until`
        ).run(
          randomUUID(), snapshot.sku_id, snapshot.id, triggerKey, result.ruleVersion, result.referencePriceEurCents,
          result.marketPrice, result.npcBuyPrice, result.npcSellPrice, result.npcBuyFee, result.npcSellFee,
          JSON.stringify(parameters), JSON.stringify(result.reasons), now, validUntil
        );
        // DO UPDATE 下 changes() 对「插入」和「更新」均返回 1，故 written 表示「落库的报价行数（新增或覆盖）」，不再是「纯新增数」。
        written += changed.changes;
      }
      return written;
    });
  }

  quote(skuId: string): QuoteDto | null {
    const row = this.database.prepare(
      `SELECT id, sku_id, rule_version, reference_price_eur_cents, market_price_amount, npc_buy_price_amount, npc_sell_price_amount, npc_buy_fee_amount, npc_sell_fee_amount, calculated_at, valid_until, reasons_json
       FROM market_quotes WHERE sku_id = ? ORDER BY calculated_at DESC, rowid DESC LIMIT 1`
    ).get(skuId) as QuoteRow | undefined;
    return row ? this.toQuote(row) : null;
  }

  /** 订单模块只可通过该应用接口取得报价快照，不拥有 market_quotes 的表访问权。 */
  npcSettlementQuote(skuId: string, side: "buy" | "sell", quoteId?: string): NpcSettlementQuote | null {
    const row = this.database.prepare(
      `SELECT quote.id, quote.sku_id, quote.rule_version,
        ${side === "buy" ? "quote.npc_sell_price_amount" : "quote.npc_buy_price_amount"} AS unit_price_amount,
        ${side === "buy" ? "quote.npc_sell_fee_amount" : "quote.npc_buy_fee_amount"} AS unit_fee_amount,
        quote.valid_until, sku.tradable
       FROM market_quotes quote JOIN card_skus sku ON sku.id = quote.sku_id
       WHERE quote.sku_id = ? ${quoteId ? "AND quote.id = ?" : ""}
       ORDER BY quote.calculated_at DESC, quote.rowid DESC LIMIT 1`
    ).get(...(quoteId ? [skuId, quoteId] : [skuId])) as
      | { id: string; sku_id: string; rule_version: string; unit_price_amount: number; unit_fee_amount: number; valid_until: string; tradable: number }
      | undefined;
    return row
      ? {
          quoteId: row.id,
          skuId: row.sku_id,
          quoteVersion: row.rule_version,
          unitPriceAmount: row.unit_price_amount,
          unitFeeAmount: row.unit_fee_amount,
          validUntil: row.valid_until,
          tradable: row.tradable === 1
        }
      : null;
  }

  /** 只读市场投影把目录筛选与最新服务端报价合并，浏览器无需也不得自行拼接或计算。 */
  list(filters: MarketQuoteFilters): Page<MarketQuoteListItemDto> {
    const where: string[] = []; const values: unknown[] = [];
    if (filters.query) { where.push("lower(p.name) LIKE lower(?)"); values.push(`%${filters.query}%`); }
    if (filters.setCode) { where.push("s.code = ?"); values.push(filters.setCode); }
    if (filters.rarity) { where.push("p.rarity = ?"); values.push(filters.rarity); }
    if (filters.finish) { where.push("sku.finish = ?"); values.push(filters.finish); }
    if (filters.tradable === "tradable") where.push("sku.tradable = 1");
    if (filters.tradable === "untradable") where.push("sku.tradable = 0");
    const offset = filters.cursor ? Number.parseInt(filters.cursor, 10) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError("市场分页游标无效");
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const from = `FROM card_skus sku
      JOIN card_printings p ON p.id = sku.printing_id
      JOIN card_sets s ON s.id = p.set_id
      LEFT JOIN market_quotes quote ON quote.rowid = (
        SELECT latest.rowid FROM market_quotes latest WHERE latest.sku_id = sku.id
        ORDER BY latest.calculated_at DESC, latest.rowid DESC LIMIT 1
      )`;
    const total = (this.database.prepare(`SELECT COUNT(*) AS count ${from} ${clause}`).get(...values) as { count: number }).count;
    const rows = this.database.prepare(
      `SELECT sku.id AS sku_id, p.name, s.code AS set_code, s.name AS set_name, p.collector_number, sku.finish, p.rarity, sku.tradable,
        quote.id, quote.rule_version, quote.reference_price_eur_cents, quote.market_price_amount, quote.npc_buy_price_amount, quote.npc_sell_price_amount, quote.npc_buy_fee_amount, quote.npc_sell_fee_amount,
        quote.calculated_at, quote.valid_until, quote.reasons_json
       ${from} ${clause}
       ORDER BY p.name COLLATE NOCASE, s.code, p.collector_number, sku.finish LIMIT ? OFFSET ?`
    ).all(...values, filters.limit + 1, offset) as MarketListRow[];
    const hasMore = rows.length > filters.limit;
    return {
      items: rows.slice(0, filters.limit).map((row) => ({
        sku: { id: row.sku_id, name: row.name, setCode: row.set_code, setName: row.set_name, collectorNumber: row.collector_number, finish: row.finish, rarity: row.rarity },
        quote: row.rule_version === null ? null : this.toQuote(row),
        tradable: row.tradable === 1,
        tradeDisabledReason: row.tradable === 1 ? (row.rule_version === null ? "quote_unavailable" : null) : "no_valid_reference_price"
      })),
      page: { total, hasMore, nextCursor: hasMore ? String(offset + filters.limit) : null }
    };
  }

  index(): { referenceIndex: number | null; gameIndex: number | null; quotedSkus: number; capturedAt: string | null } {
    const row = this.database.prepare(
      `SELECT AVG(reference_price_eur_cents) AS reference_index, AVG(market_price_amount) AS game_index,
        COUNT(*) AS quoted_skus, MAX(calculated_at) AS captured_at
       FROM market_quotes quote
       WHERE quote.rowid = (SELECT latest.rowid FROM market_quotes latest WHERE latest.sku_id = quote.sku_id ORDER BY latest.calculated_at DESC, latest.rowid DESC LIMIT 1)`
    ).get() as { reference_index: number | null; game_index: number | null; quoted_skus: number; captured_at: string | null };
    return {
      referenceIndex: row.reference_index === null ? null : Math.round(row.reference_index),
      gameIndex: row.game_index === null ? null : Math.round(row.game_index),
      quotedSkus: row.quoted_skus,
      capturedAt: row.captured_at
    };
  }

  /**
   * I17B 单卡价格历史（按自然日采样）。reference 来自只追加的 `price_snapshot_entries`，
   * game 来自只追加的 `market_quotes`；同日多次同步/重定价取该日最新值。任一缺失为 null，
   * 不掩盖空态；空 points 表示无历史而非查询失败。
   */
  history(skuId: string, range: PriceHistoryRange, now = new Date().toISOString()): PriceHistoryDto {
    const since = range === "all" ? null : new Date(now.slice(0, 10) + "T00:00:00.000Z").getTime() - (range === "7d" ? 7 : 30) * 86_400_000;
    const sinceDate = since === null ? null : new Date(since).toISOString().slice(0, 10);
    const days = new Map<string, PriceHistoryPointDto>();
    const referenceRows = this.database.prepare(
      `SELECT substr(entry.captured_at, 1, 10) AS day, entry.price_amount
       FROM price_snapshot_entries entry
       WHERE entry.sku_id = ? AND entry.availability = 'priced' AND entry.price_amount IS NOT NULL
       ${sinceDate ? "AND substr(entry.captured_at, 1, 10) >= ?" : ""}
       ORDER BY entry.captured_at DESC`
    ).all(...(sinceDate ? [skuId, sinceDate] : [skuId])) as Array<{ day: string; price_amount: number }>;
    for (const row of referenceRows) {
      if (!days.has(row.day)) days.set(row.day, { date: row.day, referencePrice: { amount: row.price_amount, currency: "EUR" }, marketPrice: null });
    }
    const gameRows = this.database.prepare(
      `SELECT substr(quote.calculated_at, 1, 10) AS day, quote.market_price_amount
       FROM market_quotes quote
       WHERE quote.sku_id = ? ${sinceDate ? "AND substr(quote.calculated_at, 1, 10) >= ?" : ""}
       ORDER BY quote.calculated_at DESC`
    ).all(...(sinceDate ? [skuId, sinceDate] : [skuId])) as Array<{ day: string; market_price_amount: number }>;
    for (const row of gameRows) {
      const point = days.get(row.day) ?? { date: row.day, referencePrice: null, marketPrice: null };
      if (point.marketPrice === null) point.marketPrice = { amount: row.market_price_amount, currency: "GAME_CREDIT" };
      days.set(row.day, point);
    }
    return {
      skuId,
      range,
      points: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)),
      referenceSource: referenceRows.length > 0 ? "mtgjson-cardmarket" : null,
      generatedAt: now
    };
  }

  /** I17B 全服市场指数历史（按自然日采样）；任一指数缺失为 null。 */
  indexHistory(range: PriceHistoryRange, now = new Date().toISOString()): MarketIndexHistoryDto {
    const since = range === "all" ? null : new Date(now.slice(0, 10) + "T00:00:00.000Z").getTime() - (range === "7d" ? 7 : 30) * 86_400_000;
    const sinceDate = since === null ? null : new Date(since).toISOString().slice(0, 10);
    const days = new Map<string, MarketIndexHistoryPointDto>();
    const referenceRows = this.database.prepare(
      `SELECT substr(entry.captured_at, 1, 10) AS day, AVG(entry.price_amount) AS avg_price, COUNT(*) AS cnt
       FROM price_snapshot_entries entry
       WHERE entry.availability = 'priced' AND entry.price_amount IS NOT NULL
       ${sinceDate ? "AND substr(entry.captured_at, 1, 10) >= ?" : ""}
       GROUP BY day`
    ).all(...(sinceDate ? [sinceDate] : [])) as Array<{ day: string; avg_price: number; cnt: number }>;
    for (const row of referenceRows) days.set(row.day, { date: row.day, referenceIndex: Math.round(row.avg_price), gameIndex: null });
    const gameRows = this.database.prepare(
      `SELECT substr(quote.calculated_at, 1, 10) AS day, AVG(quote.market_price_amount) AS avg_price
       FROM market_quotes quote
       ${sinceDate ? "WHERE substr(quote.calculated_at, 1, 10) >= ?" : ""}
       GROUP BY day`
    ).all(...(sinceDate ? [sinceDate] : [])) as Array<{ day: string; avg_price: number }>;
    for (const row of gameRows) {
      const point = days.get(row.day) ?? { date: row.day, referenceIndex: null, gameIndex: null };
      if (point.gameIndex === null) point.gameIndex = Math.round(row.avg_price);
      days.set(row.day, point);
    }
    return {
      range,
      points: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)),
      generatedAt: now
    };
  }

  private parameters(): ParametersRow {
    const parameters = this.database.prepare("SELECT rule_version, eur_cent_to_game_credit_bps, minimum_price, npc_buy_spread_bps, npc_sell_spread_bps, npc_fee_bps FROM market_parameters WHERE singleton = 1").get() as ParametersRow | undefined;
    if (!parameters || parameters.rule_version !== MARKET_RULE_VERSION) throw new Error("市场参数或规则版本未初始化");
    return parameters;
  }

  private toQuote(row: QuoteRow): QuoteDto {
    return {
      quoteId: row.id,
      skuId: row.sku_id,
      quoteVersion: row.rule_version,
      referencePrice: { amount: row.reference_price_eur_cents, currency: "EUR" },
      marketPrice: asMoney(row.market_price_amount),
      npcBuyPrice: asMoney(row.npc_buy_price_amount),
      npcSellPrice: asMoney(row.npc_sell_price_amount),
      validUntil: row.valid_until,
      source: "mtgjson-cardmarket",
      capturedAt: row.calculated_at,
      reasons: this.parseReasons(row.reasons_json)
    };
  }

  private parseReasons(value: string): MarketReason[] {
    try {
      const parsed: unknown = JSON.parse(value);
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((item): MarketReason[] => {
        if (!item || typeof item !== "object") return [];
        const reason = item as Record<string, unknown>;
        const kind = reason.kind;
        const factorBasisPoints = reason.factorBasisPoints;
        if (!(kind === "supply-demand" || kind === "series-cycle" || kind === "relation" || kind === "event" || kind === "liquidity") || typeof factorBasisPoints !== "number" || !Number.isSafeInteger(factorBasisPoints) || typeof reason.reason !== "string") return [];
        return [{ kind, factorBasisPoints, reason: reason.reason }];
      });
    } catch { return []; }
  }

  private latestSuccessfulRunId(): string | null {
    const row = this.database.prepare("SELECT latest_successful_run_id FROM price_sync_state WHERE singleton = 1").get() as { latest_successful_run_id: string | null } | undefined;
    return row?.latest_successful_run_id ?? null;
  }

  private aggregateFactPressure(): Map<string, { demand: number; supply: number; liquidity: number }> {
    const pressure = new Map<string, { demand: number; supply: number; liquidity: number }>();
    const add = (skuId: string, field: "demand" | "supply" | "liquidity", quantity: unknown) => {
      if (typeof skuId !== "string" || typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) return;
      const safeQuantity = quantity;
      const current = pressure.get(skuId) ?? { demand: 0, supply: 0, liquidity: 0 };
      current[field] += safeQuantity;
      pressure.set(skuId, current);
    };
    const rows = this.database.prepare("SELECT id, event_type, payload_json FROM fact_events WHERE event_type IN ('pack.opened', 'npc.trade.settled', 'p2p.trade.settled', 'tournament.settled') ORDER BY occurred_at ASC, id ASC").all() as FactRow[];
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.payload_json); } catch { continue; }
      if (!parsed || typeof parsed !== "object") continue;
      const payload = (parsed as { payload?: unknown }).payload;
      if (!payload || typeof payload !== "object") continue;
      const value = payload as Record<string, unknown>;
      if (row.event_type === "pack.opened" && Array.isArray(value.received)) {
        for (const card of value.received) if (card && typeof card === "object") add((card as { skuId?: string }).skuId ?? "", "supply", (card as { quantity?: unknown }).quantity);
      } else if (row.event_type === "npc.trade.settled") {
        add(typeof value.skuId === "string" ? value.skuId : "", value.side === "buy" ? "demand" : "supply", value.quantity);
      } else if (row.event_type === "p2p.trade.settled") {
        add(typeof value.skuId === "string" ? value.skuId : "", "liquidity", value.quantity);
      }
    }
    return pressure;
  }

  private factorsFor(snapshot: SnapshotRow, pressure: Map<string, { demand: number; supply: number; liquidity: number }>, now: string): MarketFactorInput[] {
    const own = pressure.get(snapshot.sku_id) ?? { demand: 0, supply: 0, liquidity: 0 };
    const pressureFactor = (demand: number, supply: number) => Math.max(5_000, Math.min(20_000, 10_000 + Math.max(-100, Math.min(100, demand - supply)) * 25));
    const factors: MarketFactorInput[] = [
      { kind: "supply-demand", factorBasisPoints: pressureFactor(own.demand, own.supply), reason: `已结算需求 ${own.demand}、供给 ${own.supply}` },
      { kind: "liquidity", factorBasisPoints: Math.max(9_500, 10_000 - Math.min(own.liquidity, 100) * 5), reason: `已结算流动性 ${own.liquidity}` }
    ];
    const cycles = this.database.prepare("SELECT factor_bps, reason FROM market_series_cycles WHERE set_id = ? AND starts_at <= ? AND ends_at > ? ORDER BY starts_at ASC, id ASC").all(snapshot.set_id, now, now) as Array<{ factor_bps: number; reason: string }>;
    for (const cycle of cycles) factors.push({ kind: "series-cycle", factorBasisPoints: cycle.factor_bps, reason: cycle.reason });
    const relations = this.database.prepare("SELECT source_sku_id, weight_bps, reason FROM market_card_relations WHERE target_sku_id = ? ORDER BY id ASC").all(snapshot.sku_id) as Array<{ source_sku_id: string; weight_bps: number; reason: string }>;
    for (const relation of relations) {
      const source = pressure.get(relation.source_sku_id) ?? { demand: 0, supply: 0, liquidity: 0 };
      factors.push({ kind: "relation", factorBasisPoints: propagateMarketPressure(source.demand - source.supply, relation.weight_bps), reason: relation.reason });
    }
    const events = this.database.prepare("SELECT factor_bps, reason FROM market_events WHERE starts_at <= ? AND ends_at > ? AND (scope_type = 'global' OR (scope_type = 'set' AND scope_id = ?) OR (scope_type = 'sku' AND scope_id = ?)) ORDER BY starts_at ASC, id ASC").all(now, now, snapshot.set_id, snapshot.sku_id) as Array<{ factor_bps: number; reason: string }>;
    for (const event of events) factors.push({ kind: "event", factorBasisPoints: event.factor_bps, reason: event.reason });
    return factors;
  }
}
