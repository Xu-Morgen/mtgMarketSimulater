"use client";

import { Pagination as AntPagination, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { BilateralOrderDto, CardFinish, MarketQuoteListItemDto, NpcTradeDto, QuoteDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { type MarketFilters, useMarketAnnouncementsQuery, useMarketHeatQuery, useMarketIndexQuery, useMarketQuotesQuery } from "../../api/market-api";
import { usePublicPriceStatusQuery } from "../../api/pricing-api";
import { CardImagePopover } from "../../components/card-image-popover";
import { PriceStatus } from "../../components/price-status";
import { EmptyState, ErrorState, FilterBar, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import { formatBasisPoints } from "../../utils/percent";
import { CreateOrderDialog } from "../orders/create-order-dialog";
import { AnnouncementsSection, MarketHeatBoard, NarrativeBanner } from "./market-heat-board";
import { NpcBuyDialog } from "./npc-buy-dialog";
import styles from "./market-page.module.css";

const defaultPageSize = 20;
const pageSizeOptions = [20, 50, 100];
const finishes: Array<{ value: CardFinish; label: string }> = [{ value: "nonfoil", label: "非闪" }, { value: "foil", label: "闪" }, { value: "etched", label: "蚀刻" }];
const factorLabels: Record<QuoteDto["reasons"][number]["kind"], string> = { "supply-demand": "供需", "series-cycle": "系列周期", relation: "卡牌关联", event: "市场活动", liquidity: "流动性", bias: "NPC 倾向" };

function formatEurCents(amount: number): string { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "EUR" }).format(amount / 100); }
function formatDate(value: string): string { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function finishLabel(finish: CardFinish): string { return finishes.find((item) => item.value === finish)?.label ?? finish; }
function filtersFromSearch(search: URLSearchParams | null): MarketFilters {
  const value = search ?? new URLSearchParams(); const finish = value.get("finish"); const requestedLimit = Number.parseInt(value.get("limit") ?? "", 10); const tradable = value.get("tradable"); const sort = value.get("sort"); const direction = value.get("direction");
  return {
    query: value.get("query") || undefined, setCode: value.get("setCode") || undefined, rarity: value.get("rarity") || undefined,
    finish: finish === "nonfoil" || finish === "foil" || finish === "etched" ? finish : undefined,
    tradable: tradable === "tradable" || tradable === "untradable" ? tradable : "any",
    sort: sort === "marketPrice" || sort === "referencePrice" ? sort : "name",
    direction: direction === "desc" ? "desc" : "asc",
    cursor: value.get("cursor") || undefined, limit: pageSizeOptions.includes(requestedLimit) ? requestedLimit : defaultPageSize
  };
}
function toUrl(filters: MarketFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value && !(key === "limit" && value === defaultPageSize) && !(key === "tradable" && value === "any") && !(key === "sort" && value === "name") && !(key === "direction" && value === "asc")) search.set(key, String(value));
  const suffix = search.toString(); return suffix ? `/market?${suffix}` : "/market";
}
function disabledText(item: MarketQuoteListItemDto): string {
  return item.tradeDisabledReason === "quote_unavailable" ? "报价投影暂不可用，不能进入交易" : "无有效参考价，暂不可新增交易";
}
function QuoteReasons({ quote }: { quote: QuoteDto }) {
  if (quote.reasons.length === 0) return <p className={styles.muted}>服务端未提供额外计算原因。</p>;
  return <ul className={styles.reasonList}>{quote.reasons.map((reason, index) => <li key={`${reason.kind}-${index}`}><strong>{factorLabels[reason.kind]}</strong>：{reason.reason}（服务端系数 {reason.factorBasisPoints} bp）</li>)}</ul>;
}

function skuHistoryHref(skuId: string): string {
  return `/market/history?skuId=${encodeURIComponent(skuId)}`;
}

/** 报价表「游戏内中间价」列的日内方向徽标：只展示服务端 heat 聚合的方向/幅度，无数据时不显示。 */
function IntradayMark({ change }: { change: { direction: "up" | "down" | "flat"; changeBasisPoints: number } | undefined }) {
  if (!change || change.direction === "flat") return null;
  const up = change.direction === "up";
  return <span className={`${styles.changeBadge} ${up ? styles.changeUp : styles.changeDown}`} aria-label={`${up ? "日内上涨" : "日内下跌"} ${formatBasisPoints(change.changeBasisPoints)}`}>{up ? "▲" : "▼"} {formatBasisPoints(change.changeBasisPoints)}</span>;
}

/** I14F 仅显示服务端报价与原因；即使是筛选、指数或金额显示，也不会在浏览器推导价格。 */
export function MarketPage() {
  const router = useRouter(); const search = useSearchParams(); const filters = filtersFromSearch(search); const quotes = useMarketQuotesQuery(filters); const index = useMarketIndexQuery(); const priceStatus = usePublicPriceStatusQuery();
  const heat = useMarketHeatQuery();
  const announcements = useMarketAnnouncementsQuery();
  const [draft, setDraft] = useState<{ query: string; setCode: string; rarity: string; finish: CardFinish | ""; tradable: "any" | "tradable" | "untradable" }>({ query: filters.query ?? "", setCode: filters.setCode ?? "", rarity: filters.rarity ?? "", finish: filters.finish ?? "", tradable: filters.tradable ?? "any" });
  const [buyItem, setBuyItem] = useState<MarketQuoteListItemDto | null>(null);
  const [orderItem, setOrderItem] = useState<MarketQuoteListItemDto | null>(null);
  const [completedTrade, setCompletedTrade] = useState<NpcTradeDto | null>(null);
  const [completedOrder, setCompletedOrder] = useState<BilateralOrderDto | null>(null);
  const beginBuy = useCallback((item: MarketQuoteListItemDto) => { setCompletedTrade(null); setBuyItem(item); }, []);
  const beginOrder = useCallback((item: MarketQuoteListItemDto) => { setCompletedOrder(null); setOrderItem(item); }, []);
  const pageSize = filters.limit ?? defaultPageSize; const currentPage = Math.floor(Number.parseInt(filters.cursor ?? "0", 10) / pageSize) + 1;
  // I34F：把服务端 heat 聚合的日内涨跌方向按 SKU 建索引，供报价表价格列显示 ▲/▼（无数据不显示）。
  const intradayBySku = useMemo(() => {
    const dto = heat.data?.data;
    const map = new Map<string, { direction: "up" | "down" | "flat"; changeBasisPoints: number }>();
    if (dto) for (const entry of [...dto.intradayGainers, ...dto.intradayLosers]) map.set(entry.sku.id, { direction: entry.direction, changeBasisPoints: entry.changeBasisPoints });
    return map;
  }, [heat.data]);
  const columns = useMemo<ColumnsType<MarketQuoteListItemDto>>(() => [
    { title: "卡牌 / 印刷", key: "sku", render: (_, item) => (
      <div>
        <div className={styles.skuName}>
          <Link className={styles.heatName} href={skuHistoryHref(item.sku.id)}>{item.sku.name}</Link>
          <CardImagePopover imagePath={item.sku.imagePath} name={item.sku.name}>
            <button type="button" className={styles.previewTrigger} aria-label={`预览 ${item.sku.name} 卡图`} title="悬浮查看卡图">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                <circle cx="8.5" cy="8.5" r="1.5" />
                <polyline points="21 15 16 10 5 21" />
              </svg>
            </button>
          </CardImagePopover>
        </div>
        <span className={styles.muted}>{item.sku.setCode} · #{item.sku.collectorNumber} · {finishLabel(item.sku.finish)} · {item.sku.rarity}</span>
      </div>
    ) },
    { title: "Cardmarket EUR 参考价", key: "reference", render: (_, item) => item.quote?.referencePrice ? <Link className={styles.historyPrice} href={skuHistoryHref(item.sku.id)}>{formatEurCents(item.quote.referencePrice.amount)}</Link> : <Tag>无有效参考价</Tag> },
    { title: "游戏内中间价", key: "market", render: (_, item) => item.quote ? <div className={styles.priceCell}><Link className={styles.historyPrice} href={skuHistoryHref(item.sku.id)}>{formatMoney(item.quote.marketPrice)}</Link><IntradayMark change={intradayBySku.get(item.sku.id)} /></div> : <Tag>报价暂不可用</Tag> },
    { title: "NPC 报价", key: "npc", render: (_, item) => item.quote ? <div><div>NPC 买入：{formatMoney(item.quote.npcBuyPrice)}</div><div>NPC 卖出：{formatMoney(item.quote.npcSellPrice)}</div></div> : "—" },
    { title: "计算原因摘要", key: "reason", render: (_, item) => item.quote ? <span className={styles.muted}>{item.quote.reasons.find((reason) => reason.kind === "event") ? `市场活动：${item.quote.reasons.find((reason) => reason.kind === "event")!.reason}（服务端系数 ${item.quote.reasons.find((reason) => reason.kind === "event")!.factorBasisPoints} bp）` : item.quote.reasons[0]?.reason ?? "服务端报价投影"}</span> : "—" },
    { title: "交易状态", key: "status", render: (_, item) => item.tradable && item.quote ? <div className={styles.actionGroup}><button type="button" className="button" onClick={() => beginBuy(item)}>向 NPC 买入</button><button type="button" className="button secondary" onClick={() => beginOrder(item)}>挂买单</button></div> : <div><button type="button" className={styles.disabledEntry} disabled title={disabledText(item)}>暂不可交易</button><span className={styles.muted}>{disabledText(item)}</span></div> }
  ], [beginBuy, beginOrder, intradayBySku]);
  if (quotes.isPending) return <PageSkeleton label="正在加载市场报价" />;
  if (quotes.isError) return <main className="page"><ErrorState title="市场报价加载失败" onRetry={() => { void quotes.refetch(); void index.refetch(); void priceStatus.refetch(); void heat.refetch(); void announcements.refetch(); }} /></main>;
  const quotePage = quotes.data.data; const marketIndex = index.data?.data; const total = quotePage.page.total ?? (currentPage - 1) * pageSize + quotePage.items.length + (quotePage.page.hasMore ? 1 : 0);
  const apply = () => router.push(toUrl({ query: draft.query.trim() || undefined, setCode: draft.setCode.trim().toUpperCase() || undefined, rarity: draft.rarity.trim() || undefined, finish: draft.finish || undefined, tradable: draft.tradable, sort: filters.sort, direction: filters.direction, limit: pageSize }));
  return <main className="page market-page"><p className="eyebrow">服务端市场报价投影</p><h1>市场</h1><p className="intro">外部参考价、游戏内价和 NPC 报价均由服务端保存后返回。页面只展示报价，不会计算兑换、价差或活动影响。需要查看历史曲线时前往<a href="/market/history" className="text-button">价格历史与市场曲线</a>，设置目标价提醒可前往<a href="/watchlist" className="text-button">价格提醒</a>。</p>
    <section className={`${styles.summary} notice-board`} aria-label="市场指数与价格状态"><article><span>外部参考指数</span><strong className="num">{marketIndex?.referenceIndex === null || marketIndex === undefined ? "暂不可用" : formatEurCents(marketIndex.referenceIndex)}</strong><small className={styles.muted}>{marketIndex?.capturedAt ? `报价计算于 ${formatDate(marketIndex.capturedAt)}` : "暂无持久化报价"}</small></article><article><span>游戏内市场指数</span><strong className="num">{marketIndex?.gameIndex === null || marketIndex === undefined ? "暂不可用" : formatMoney({ amount: marketIndex.gameIndex, currency: "GAME_CREDIT" })}</strong><small className={styles.muted}>{marketIndex ? `${marketIndex.quotedSkus} 个 SKU 已报价` : "指数查询失败"}</small></article><article><span>来源与交易新鲜度</span><PriceStatus status={priceStatus.isError ? null : priceStatus.data?.data} tradable /></article></section>
    {priceStatus.data?.data.freshness === "stale" ? <p className={styles.stale} role="status">价格同步失败时沿用最近成功快照；这不是实时 Cardmarket 价格。</p> : null}
    {index.isError ? <p className={styles.stale} role="status">市场指数暂不可读取；下方仅展示成功取得的单卡报价。</p> : null}
    {heat.isError ? <p className={styles.stale} role="status">行情屏暂不可读取；下方仅展示成功取得的报价列表。</p> : null}
    <NarrativeBanner quotes={quotePage.items} />
    {heat.data?.data ? <MarketHeatBoard heat={heat.data.data} /> : null}
    {announcements.data?.data ? <AnnouncementsSection items={announcements.data.data.items} /> : null}
    {completedTrade ? <section className={styles.tradeSuccess} role="status"><h2>买入已完成</h2><p>服务端已成交 {completedTrade.quantity} 张，实际扣款 {formatMoney(completedTrade.total)}（其中费用 {formatMoney(completedTrade.fee)}）。余额、库存、报价与账本正在按服务器响应刷新。</p></section> : null}
    {completedOrder ? <section className={styles.tradeSuccess} role="status"><h2>挂单已创建</h2><p>服务端已创建{completedOrder.side === "buy" ? "买单" : "卖单"}（限价 {formatMoney(completedOrder.limitPrice)}，数量 {completedOrder.originalQuantity} 张，状态 {completedOrder.status}）。余额、库存、报价、委托与账本正在按服务器响应刷新；撮合与履约在后续迭代上线。</p></section> : null}
    <form className="catalog-filters" onSubmit={(event) => { event.preventDefault(); apply(); }}><FilterBar><label>名称<input aria-label="市场名称筛选" value={draft.query} onChange={(event) => setDraft({ ...draft, query: event.target.value })} /></label><label>系列<input aria-label="市场系列筛选" value={draft.setCode} onChange={(event) => setDraft({ ...draft, setCode: event.target.value })} placeholder="例如 ONE" /></label><label>稀有度<input aria-label="市场稀有度筛选" value={draft.rarity} onChange={(event) => setDraft({ ...draft, rarity: event.target.value })} placeholder="例如 rare" /></label><label>工艺<select aria-label="市场工艺筛选" value={draft.finish} onChange={(event) => setDraft({ ...draft, finish: event.target.value as CardFinish | "" })}><option value="">全部</option>{finishes.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><label>交易状态<select aria-label="市场交易状态筛选" value={draft.tradable} onChange={(event) => setDraft({ ...draft, tradable: event.target.value as "any" | "tradable" | "untradable" })}><option value="any">全部</option><option value="tradable">可新增交易</option><option value="untradable">不可新增交易</option></select></label><label>排序<select aria-label="市场排序" value={`${filters.sort}:${filters.direction}`} onChange={(event) => { const [sort, direction] = event.target.value.split(":") as [NonNullable<MarketFilters["sort"]>, NonNullable<MarketFilters["direction"]>]; router.push(toUrl({ ...filters, sort, direction, cursor: undefined })); }}><option value="name:asc">名称（升序）</option><option value="marketPrice:desc">游戏内中间价（降序）</option><option value="marketPrice:asc">游戏内中间价（升序）</option><option value="referencePrice:desc">EUR 参考价（降序）</option><option value="referencePrice:asc">EUR 参考价（升序）</option></select></label><button className="button" type="submit">应用筛选</button><button className="button secondary" type="button" onClick={() => { setDraft({ query: "", setCode: "", rarity: "", finish: "", tradable: "any" }); router.push("/market"); }}>清除</button></FilterBar></form>
    {quotePage.items.length === 0 ? <EmptyState title="没有符合条件的市场报价">调整筛选条件，或等待服务端完成价格同步与重定价。</EmptyState> : <><div className={styles.tableWrap}><Table columns={columns} dataSource={quotePage.items} rowKey={(item) => item.sku.id} pagination={false} scroll={{ x: 1160 }} expandable={{ expandedRowRender: (item) => item.quote ? <section className={`${styles.quoteCard} panel`}><h2>计算原因与版本</h2><p className={styles.muted}>规则版本：{item.quote.quoteVersion}；报价计算于 {formatDate(item.quote.capturedAt)}</p><QuoteReasons quote={item.quote} /></section> : <p className={styles.muted}>没有有效外部参考价或已持久化报价，因此交易入口保持禁用。</p>, rowExpandable: (item) => item.quote !== null }} /></div><div className="pagination"><AntPagination current={currentPage} pageSize={pageSize} total={total} showSizeChanger showQuickJumper pageSizeOptions={pageSizeOptions} showTotal={(count, range) => `第 ${range[0]}–${range[1]} 张，共 ${count} 张`} onChange={(nextPage, nextPageSize) => { const nextLimit = Number(nextPageSize); const sizeChanged = nextLimit !== pageSize; router.push(toUrl({ ...filters, limit: nextLimit, cursor: sizeChanged || nextPage === 1 ? undefined : String((nextPage - 1) * nextLimit) })); }} /></div></>}
    {buyItem ? <NpcBuyDialog item={buyItem} onClose={() => setBuyItem(null)} onSettled={(trade) => { setBuyItem(null); setCompletedTrade(trade); }} /> : null}
    {orderItem ? <CreateOrderDialog sku={{ id: orderItem.sku.id, name: orderItem.sku.name, setCode: orderItem.sku.setCode, collectorNumber: orderItem.sku.collectorNumber }} initialSide="buy" onClose={() => setOrderItem(null)} onSettled={(order) => { setOrderItem(null); setCompletedOrder(order); }} /> : null}
  </main>;
}
