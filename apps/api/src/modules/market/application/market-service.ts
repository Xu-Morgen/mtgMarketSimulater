import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { calculateMarketQuote, marketQuoteValidUntil, MARKET_RULE_VERSION, propagateMarketPressure, type MarketFactorInput } from "@mtg-market/rules";
import type { MarketAnnouncementDto, MarketAnnouncementsDto, MarketHeatDto, MarketHeatEntryDto, MarketIndexDto, MarketIndexHistoryDto, MarketIndexHistoryPointDto, MarketQuoteListItemDto, Page, PriceHistoryDto, PriceHistoryPointDto, PriceHistoryRange, QuoteDto } from "@mtg-market/contracts";
import { withinTransaction } from "@mtg-market/database";
import { publicImagePath } from "../../../shared/catalog/image-path.js";

type ParametersRow = { rule_version: string; eur_cent_to_game_credit_bps: number; minimum_price: number; npc_buy_spread_bps: number; npc_sell_spread_bps: number; npc_fee_bps: number; npc_bias_bps: number; npc_bias_reason: string };
type SnapshotRow = { id: string; sku_id: string; price_amount: number; captured_at: string; source_version: string; set_id: string };
type MarketReason = NonNullable<QuoteDto["reasons"]>[number];
type QuoteRow = { id: string; sku_id: string; rule_version: string; reference_price_eur_cents: number; market_price_amount: number; npc_buy_price_amount: number; npc_sell_price_amount: number; npc_buy_fee_amount: number; npc_sell_fee_amount: number; calculated_at: string; valid_until: string; reasons_json: string };
type MarketListRow = QuoteRow & { name: string; set_code: string; set_name: string; collector_number: string; finish: "nonfoil" | "foil" | "etched"; rarity: string; tradable: number; image_path: string | null };
type FactRow = { id: string; event_type: string; payload_json: string };
type HeatQuoteRow = { sku_id: string; day: string; market_price_amount: number; calculated_at: string; name: string; set_code: string; set_name: string; collector_number: string; finish: "nonfoil" | "foil" | "etched"; rarity: string };

export type MarketRepricePayload = { priceSyncRunId?: string; triggerKey?: string };
export type MarketQuoteFilters = {
  query?: string | undefined;
  setCode?: string | undefined;
  rarity?: string | undefined;
  finish?: "nonfoil" | "foil" | "etched" | undefined;
  tradable?: "any" | "tradable" | "untradable" | undefined;
  sort: "name" | "marketPrice" | "referencePrice";
  direction: "asc" | "desc";
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
        const factors = this.factorsFor(snapshot, pressure, parameters, now);
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
    const direction = filters.direction.toUpperCase();
    // 排序键与 direction 均经 zod 白名单校验；价格列经 LEFT JOIN 可能为 NULL，以 IS NULL ASC 使无报价 SKU 在两种方向下都垫后。
    const order: Record<MarketQuoteFilters["sort"], string> = {
      name: `p.name COLLATE NOCASE ${direction}, s.code, p.collector_number, sku.finish`,
      marketPrice: `quote.market_price_amount IS NULL ASC, quote.market_price_amount ${direction}`,
      referencePrice: `quote.reference_price_eur_cents IS NULL ASC, quote.reference_price_eur_cents ${direction}`
    };
    // 价格排序后追加名称作稳定 tiebreaker，保证分页稳定；名称分支已含 tiebreaker。
    const tail = filters.sort === "name" ? "" : ", p.name COLLATE NOCASE ASC";
    const from = `FROM card_skus sku
      JOIN card_printings p ON p.id = sku.printing_id
      JOIN card_sets s ON s.id = p.set_id
      LEFT JOIN card_image_cache image ON image.printing_id = p.id
      LEFT JOIN market_quotes quote ON quote.rowid = (
        SELECT latest.rowid FROM market_quotes latest WHERE latest.sku_id = sku.id
        ORDER BY latest.calculated_at DESC, latest.rowid DESC LIMIT 1
      )`;
    const total = (this.database.prepare(`SELECT COUNT(*) AS count ${from} ${clause}`).get(...values) as { count: number }).count;
    const rows = this.database.prepare(
      `SELECT sku.id AS sku_id, p.name, s.code AS set_code, s.name AS set_name, p.collector_number, sku.finish, p.rarity, sku.tradable, image.cache_path AS image_path,
        quote.id, quote.rule_version, quote.reference_price_eur_cents, quote.market_price_amount, quote.npc_buy_price_amount, quote.npc_sell_price_amount, quote.npc_buy_fee_amount, quote.npc_sell_fee_amount,
        quote.calculated_at, quote.valid_until, quote.reasons_json
       ${from} ${clause}
       ORDER BY ${order[filters.sort]}${tail} LIMIT ? OFFSET ?`
    ).all(...values, filters.limit + 1, offset) as MarketListRow[];
    const hasMore = rows.length > filters.limit;
    return {
      items: rows.slice(0, filters.limit).map((row) => ({
        sku: { id: row.sku_id, name: row.name, setCode: row.set_code, setName: row.set_name, collectorNumber: row.collector_number, finish: row.finish, rarity: row.rarity, imagePath: publicImagePath(row.image_path) },
        quote: row.rule_version === null ? null : this.toQuote(row),
        tradable: row.tradable === 1,
        tradeDisabledReason: row.tradable === 1 ? (row.rule_version === null ? "quote_unavailable" : null) : "no_valid_reference_price"
      })),
      page: { total, hasMore, nextCursor: hasMore ? String(offset + filters.limit) : null }
    };
  }

  index(): MarketIndexDto {
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

  /**
   * I34B：市场热度只读聚合。涨跌幅按 `market_quotes` 自然日采样（复用 I17B 取样语义）：
   * 日内基准为「当前日之前最近一个采样日」，7 日基准为窗口内最早采样日；无基准（首日）返回
   * `basePrice: null` 且 direction=flat。`mostActive` 按当日已结算 NPC/P2P 成交（张数与金额）
   * 聚合。全部计算只读服务端快照与事实，浏览器不得重算。
   */
  heat(now = new Date().toISOString()): MarketHeatDto {
    const today = now.slice(0, 10);
    const since = new Date(Date.parse(today + "T00:00:00.000Z") - 8 * 86_400_000).toISOString().slice(0, 10);
    const rows = this.database.prepare(
      `SELECT quote.sku_id, quote.market_price_amount, substr(quote.calculated_at, 1, 10) AS day,
        p.name, s.code AS set_code, s.name AS set_name, p.collector_number, sku.finish, p.rarity
       FROM market_quotes quote
       JOIN card_skus sku ON sku.id = quote.sku_id
       JOIN card_printings p ON p.id = sku.printing_id
       JOIN card_sets s ON s.id = p.set_id
       WHERE substr(quote.calculated_at, 1, 10) >= ?
       ORDER BY quote.calculated_at DESC, quote.rowid DESC`
    ).all(since) as HeatQuoteRow[];
    const bySku = new Map<string, { sku: MarketHeatEntryDto["sku"]; days: Array<{ day: string; price: number }> }>();
    for (const row of rows) {
      const entry = bySku.get(row.sku_id) ?? {
        sku: { id: row.sku_id, name: row.name, setCode: row.set_code, setName: row.set_name, collectorNumber: row.collector_number, finish: row.finish, rarity: row.rarity },
        days: []
      };
      if (!entry.days.some((point) => point.day === row.day)) entry.days.push({ day: row.day, price: row.market_price_amount });
      bySku.set(row.sku_id, entry);
    }
    const compute = (base: { day: string; price: number } | null | undefined, current: { day: string; price: number }) => {
      if (!base || base.price === current.price) return { changeBasisPoints: 0, direction: "flat" as const, basePrice: base ? { amount: base.price, currency: "GAME_CREDIT" as const } : null };
      if (!Number.isSafeInteger(Math.abs(current.price - base.price) * 10_000)) return { changeBasisPoints: 0, direction: "flat" as const, basePrice: { amount: base.price, currency: "GAME_CREDIT" as const } };
      const changeBasisPoints = Math.trunc(((current.price - base.price) * 10_000) / base.price);
      return { changeBasisPoints, direction: (changeBasisPoints > 0 ? "up" : "down") as "up" | "down", basePrice: { amount: base.price, currency: "GAME_CREDIT" as const } };
    };
    const intraday: MarketHeatEntryDto[] = [];
    const sevenDay: MarketHeatEntryDto[] = [];
    for (const { sku, days } of bySku.values()) {
      const current = days[0]!;
      const intradayBase = days.find((point) => point.day !== current.day);
      const sevenDayBase = days[days.length - 1];
      intraday.push({ sku, ...compute(intradayBase, current), currentPrice: { amount: current.price, currency: "GAME_CREDIT" } });
      sevenDay.push({ sku, ...compute(sevenDayBase, current), currentPrice: { amount: current.price, currency: "GAME_CREDIT" } });
    }
    const topGainers = (entries: MarketHeatEntryDto[]) => entries.filter((entry) => entry.direction === "up").sort((a, b) => b.changeBasisPoints - a.changeBasisPoints).slice(0, 10);
    const topLosers = (entries: MarketHeatEntryDto[]) => entries.filter((entry) => entry.direction === "down").sort((a, b) => a.changeBasisPoints - b.changeBasisPoints).slice(0, 10);

    const npcActivity = this.database.prepare(
      `SELECT sku_id, SUM(quantity) AS quantity, SUM(total_amount) AS turnover
       FROM npc_trades WHERE settlement_date = ? GROUP BY sku_id`
    ).all(today) as Array<{ sku_id: string; quantity: number; turnover: number }>;
    const p2pActivity = this.database.prepare(
      `SELECT sku_id, SUM(quantity) AS quantity, SUM(execution_price_amount * quantity) AS turnover
       FROM bilateral_trades WHERE status = 'fulfilled' AND substr(created_at, 1, 10) = ? GROUP BY sku_id`
    ).all(today) as Array<{ sku_id: string; quantity: number; turnover: number }>;
    const activity = new Map<string, { quantity: number; turnover: number }>();
    for (const row of [...npcActivity, ...p2pActivity]) {
      const current = activity.get(row.sku_id) ?? { quantity: 0, turnover: 0 };
      activity.set(row.sku_id, { quantity: current.quantity + row.quantity, turnover: current.turnover + row.turnover });
    }
    const skuInfo = new Map(bySku);
    const mostActive = [...activity.entries()]
      .map(([skuId, stats]) => ({ skuId, ...stats, sku: (skuInfo.get(skuId)?.sku ?? { id: skuId, name: "未知卡牌", setCode: "", setName: "", collectorNumber: "", finish: "nonfoil" as const, rarity: "" }) }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10)
      .map(({ sku, quantity, turnover }) => ({ sku, quantity, turnover: { amount: turnover, currency: "GAME_CREDIT" as const } }));

    return {
      intradayGainers: topGainers(intraday),
      intradayLosers: topLosers(intraday),
      sevenDayGainers: topGainers(sevenDay),
      sevenDayLosers: topLosers(sevenDay),
      mostActive,
      capturedAt: now
    };
  }

  /**
   * I34B：系列周期与市场活动公告只读聚合。只暴露标题、影响范围与生效区间，绝不暴露
   * factor_bps 等内部系数与配置；只返回当前 UTC 时刻生效中的公告，到期即不再返回。
   */
  announcements(now = new Date().toISOString()): MarketAnnouncementsDto {
    const items: MarketAnnouncementDto[] = [];
    const cycles = this.database.prepare(
      `SELECT s.code AS set_code, s.name AS set_name, cycle.starts_at, cycle.ends_at, cycle.reason
       FROM market_series_cycles cycle JOIN card_sets s ON s.id = cycle.set_id
       WHERE cycle.starts_at <= ? AND cycle.ends_at > ?
       ORDER BY cycle.starts_at ASC, cycle.id ASC`
    ).all(now, now) as Array<{ set_code: string; set_name: string; starts_at: string; ends_at: string; reason: string }>;
    for (const cycle of cycles) {
      items.push({
        type: "series_cycle",
        title: `系列周期：${cycle.set_name}`,
        scope: "set",
        setCode: cycle.set_code,
        setName: cycle.set_name,
        skuName: null,
        startsAt: cycle.starts_at,
        endsAt: cycle.ends_at,
        reason: cycle.reason
      });
    }
    const events = this.database.prepare(
      `SELECT event.scope_type, event.scope_id, event.starts_at, event.ends_at, event.reason, campaign.name AS campaign_name,
        s.code AS set_code, s.name AS set_name, p.name AS sku_name
       FROM market_events event
       LEFT JOIN admin_campaigns campaign ON campaign.published_market_event_id = event.id
       LEFT JOIN card_sets s ON s.id = event.scope_id AND event.scope_type = 'set'
       LEFT JOIN card_skus sku ON sku.id = event.scope_id AND event.scope_type = 'sku'
       LEFT JOIN card_printings p ON p.id = sku.printing_id
       WHERE event.starts_at <= ? AND event.ends_at > ?
       ORDER BY event.starts_at ASC, event.id ASC`
    ).all(now, now) as Array<{ scope_type: string; scope_id: string | null; starts_at: string; ends_at: string; reason: string; campaign_name: string | null; set_code: string | null; set_name: string | null; sku_name: string | null }>;
    for (const event of events) {
      const scope = event.scope_type === "global" ? "global" as const : event.scope_type === "set" ? "set" as const : "sku" as const;
      items.push({
        type: "market_event",
        title: event.campaign_name ?? "市场活动",
        scope,
        setCode: event.set_code,
        setName: event.set_name,
        skuName: event.sku_name,
        startsAt: event.starts_at,
        endsAt: event.ends_at,
        reason: event.reason
      });
    }
    return { items, capturedAt: now };
  }

  private parameters(): ParametersRow {
    const parameters = this.database.prepare("SELECT rule_version, eur_cent_to_game_credit_bps, minimum_price, npc_buy_spread_bps, npc_sell_spread_bps, npc_fee_bps, npc_bias_bps, npc_bias_reason FROM market_parameters WHERE singleton = 1").get() as ParametersRow | undefined;
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
        if (!(kind === "supply-demand" || kind === "series-cycle" || kind === "relation" || kind === "event" || kind === "liquidity" || kind === "bias") || typeof factorBasisPoints !== "number" || !Number.isSafeInteger(factorBasisPoints) || typeof reason.reason !== "string") return [];
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

  private factorsFor(snapshot: SnapshotRow, pressure: Map<string, { demand: number; supply: number; liquidity: number }>, parameters: ParametersRow, now: string): MarketFactorInput[] {
    const own = pressure.get(snapshot.sku_id) ?? { demand: 0, supply: 0, liquidity: 0 };
    const pressureFactor = (demand: number, supply: number) => Math.max(5_000, Math.min(20_000, 10_000 + Math.max(-100, Math.min(100, demand - supply)) * 25));
    const factors: MarketFactorInput[] = [
      { kind: "supply-demand", factorBasisPoints: pressureFactor(own.demand, own.supply), reason: `已结算需求 ${own.demand}、供给 ${own.supply}` },
      { kind: "liquidity", factorBasisPoints: Math.max(9_500, 10_000 - Math.min(own.liquidity, 100) * 5), reason: `已结算流动性 ${own.liquidity}` }
    ];
    // I34B（E8/E14 增强）：NPC 做市商倾向是管理员可配置的全局因素（受 5000–20000 界约束），
    // 作为独立 reason 写入每个 SKU 的报价，不改变外部参考价快照。
    factors.push({ kind: "bias", factorBasisPoints: parameters.npc_bias_bps, reason: parameters.npc_bias_reason });
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
