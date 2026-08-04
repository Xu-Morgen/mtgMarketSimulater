"use client";

import { Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { CardFinish, MarketIndexHistoryPointDto, MarketQuoteListItemDto, PriceHistoryPointDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";
import { type MarketFilters, useMarketQuotesQuery, useMarketIndexHistoryQuery, usePriceHistoryQuery } from "../../api/market-api";
import { usePublicPriceStatusQuery } from "../../api/pricing-api";
import { PriceStatus } from "../../components/price-status";
import { type ChartSeries, DualLineChart } from "../../components/market/price-history-chart";
import { EmptyState, ErrorState, FilterBar, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import styles from "./price-history-page.module.css";

const finishes: Array<{ value: CardFinish; label: string }> = [{ value: "nonfoil", label: "非闪" }, { value: "foil", label: "闪" }, { value: "etched", label: "蚀刻" }];
const ranges: Array<{ value: "7d" | "30d" | "all"; label: string }> = [{ value: "7d", label: "近 7 天" }, { value: "30d", label: "近 30 天" }, { value: "all", label: "全部" }];
const referenceColor = "#c9a24b";
const gameColor = "#3b7dd8";

function formatEurCents(amount: number): string { return new Intl.NumberFormat("zh-CN", { style: "currency", currency: "EUR" }).format(amount / 100); }
function finishLabel(finish: CardFinish): string { return finishes.find((item) => item.value === finish)?.label ?? finish; }

function filtersFromSearch(search: URLSearchParams | null): MarketFilters {
  const value = search ?? new URLSearchParams();
  const finish = value.get("finish");
  return {
    query: value.get("query") || undefined,
    setCode: value.get("setCode") || undefined,
    rarity: value.get("rarity") || undefined,
    finish: finish === "nonfoil" || finish === "foil" || finish === "etched" ? finish : undefined,
    limit: 20
  };
}

function rangeFromSearch(search: URLSearchParams | null): "7d" | "30d" | "all" {
  const value = search?.get("range");
  return value === "7d" || value === "30d" || value === "all" ? value : "30d";
}

function skuSearchUrl(filters: MarketFilters): string {
  const search = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  for (const [key, val] of Object.entries(filters)) if (val) search.set(key, String(val));
  const suffix = search.toString();
  return suffix ? `/market/history?${suffix}` : "/market/history";
}

function toSkuHistorySeries(points: PriceHistoryPointDto[]): { dates: string[]; series: ChartSeries[]; referenceSource: string | null } {
  const dates = points.map((point) => point.date);
  return {
    dates,
    series: [
      { name: "Cardmarket EUR 参考价", unitLabel: "EUR 分", color: referenceColor, values: points.map((point) => point.referencePrice?.amount ?? null) },
      { name: "游戏内中间价", unitLabel: "游戏币", color: gameColor, values: points.map((point) => point.marketPrice?.amount ?? null) }
    ],
    referenceSource: points.some((point) => point.referencePrice !== null) ? "mtgjson-cardmarket" : null
  };
}

function toIndexHistorySeries(points: MarketIndexHistoryPointDto[]): { dates: string[]; series: ChartSeries[] } {
  const dates = points.map((point) => point.date);
  return {
    dates,
    series: [
      { name: "外部参考指数", unitLabel: "EUR 分均值", color: referenceColor, values: points.map((point) => point.referenceIndex) },
      { name: "游戏内市场指数", unitLabel: "游戏币均值", color: gameColor, values: points.map((point) => point.gameIndex) }
    ]
  };
}

function SkuHistoryTable({ points }: { points: PriceHistoryPointDto[] }) {
  const columns = useMemo<ColumnsType<PriceHistoryPointDto>>(() => [
    { title: "日期（UTC）", key: "date", render: (_, point) => point.date },
    { title: "Cardmarket EUR 参考价", key: "reference", render: (_, point) => point.referencePrice ? formatEurCents(point.referencePrice.amount) : "当日无快照" },
    { title: "游戏内中间价", key: "market", render: (_, point) => point.marketPrice ? formatMoney(point.marketPrice) : "当日无报价" }
  ], []);
  return <div className={styles.tableWrap}><Table size="small" columns={columns} dataSource={points} rowKey={(point) => point.date} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 520 }} /></div>;
}

function IndexHistoryTable({ points }: { points: MarketIndexHistoryPointDto[] }) {
  const columns = useMemo<ColumnsType<MarketIndexHistoryPointDto>>(() => [
    { title: "日期（UTC）", key: "date", render: (_, point) => point.date },
    { title: "外部参考指数", key: "reference", render: (_, point) => point.referenceIndex === null ? "当日无快照" : formatEurCents(point.referenceIndex) },
    { title: "游戏内市场指数", key: "market", render: (_, point) => point.gameIndex === null ? "当日无报价" : formatMoney({ amount: point.gameIndex, currency: "GAME_CREDIT" }) }
  ], []);
  return <div className={styles.tableWrap}><Table size="small" columns={columns} dataSource={points} rowKey={(point) => point.date} pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 520 }} /></div>;
}

function RangeToggle({ range, onSelect }: { range: "7d" | "30d" | "all"; onSelect: (next: "7d" | "30d" | "all") => void }) {
  return <div className={styles.rangeBar} role="group" aria-label="价格历史时间范围">{ranges.map((item) => <button key={item.value} type="button" className={styles.rangeButton} aria-pressed={range === item.value} onClick={() => onSelect(item.value)}>{item.label}</button>)}</div>;
}

/** I17F 价格历史页只读取服务端按日采样的历史，不在浏览器插值或重算指数。 */
export function PriceHistoryPage() {
  const router = useRouter();
  const search = useSearchParams();
  const filters = filtersFromSearch(search);
  const range = rangeFromSearch(search);
  const skuIdParam = search.get("skuId") || null;
  const priceStatus = usePublicPriceStatusQuery();
  const indexHistory = useMarketIndexHistoryQuery(range);
  const skuHistory = usePriceHistoryQuery(skuIdParam, range);
  const quotes = useMarketQuotesQuery(filters);
  const [draft, setDraft] = useState<{ query: string; setCode: string; rarity: string; finish: CardFinish | "" }>({ query: filters.query ?? "", setCode: filters.setCode ?? "", rarity: filters.rarity ?? "", finish: filters.finish ?? "" });

  const selectRange = useCallback((next: "7d" | "30d" | "all") => {
    const params = new URLSearchParams(search ? search : undefined);
    params.set("range", next);
    router.push(`/market/history?${params.toString()}`);
  }, [router, search]);

  const selectSku = useCallback((item: MarketQuoteListItemDto) => {
    const params = new URLSearchParams(search ? search : undefined);
    params.set("skuId", item.sku.id);
    router.push(`/market/history?${params.toString()}`);
  }, [router, search]);

  const applySearch = () => router.push(skuSearchUrl({ query: draft.query.trim() || undefined, setCode: draft.setCode.trim().toUpperCase() || undefined, rarity: draft.rarity.trim() || undefined, finish: draft.finish || undefined, limit: 20 }));

  const status = priceStatus.data?.data ?? null;
  const isStale = status?.freshness === "stale";

  if (priceStatus.isPending) return <PageSkeleton label="正在加载价格历史与数据状态" />;

  const indexPoints = indexHistory.data?.data.points ?? [];
  const indexSeries = toIndexHistorySeries(indexPoints);
  const indexAria = indexPoints.length === 0
    ? "市场指数历史为空，服务端暂无历史快照"
    : `市场指数双曲线，覆盖 ${indexPoints.length} 个自然日；金色为 Cardmarket EUR 参考指数均值，蓝色为游戏内市场指数均值，缺失日断线。`;

  const skuPoints = skuHistory.data?.data.points ?? [];
  const { dates: skuDates, series: skuSeries } = toSkuHistorySeries(skuPoints);
  const selectedSku = quotes.data?.data.items.find((item) => item.sku.id === skuIdParam) ?? null;
  const skuAria = skuPoints.length === 0
    ? "该 SKU 价格历史为空"
    : `${selectedSku ? selectedSku.sku.name : "该 SKU"} 双曲线，覆盖 ${skuPoints.length} 个自然日；金色为 Cardmarket EUR 参考价，蓝色为游戏内中间价，缺失日断线。`;

  return <main className="page">
    <p className="eyebrow">服务端价格历史投影</p>
    <h1>价格历史与市场曲线</h1>
    <p className="intro">所有历史点均由服务端按 UTC 自然日采样后返回。金色曲线为 Cardmarket EUR 参考价/指数，蓝色曲线为游戏内报价/指数；某日缺失参考价或游戏内报价时该段断线，浏览器不插值、不重算。</p>

    <section className={styles.chartCard} aria-label="市场指数历史">
      <div className={styles.summaryHeader}><span>市场指数历史</span><Link href="/market" className="text-button">返回市场报价列表</Link></div>
      <PriceStatus status={status} tradable={false} />
      {isStale ? <p className={styles.stale} role="status">价格同步失败时沿用最近成功快照；这不是实时 Cardmarket 价格。</p> : null}
      <RangeToggle range={range} onSelect={selectRange} />
      {indexHistory.isError
        ? <ErrorState title="市场指数历史读取失败" onRetry={() => void indexHistory.refetch()} />
        : indexPoints.length === 0
          ? <EmptyState title="暂无市场指数历史">等待服务端完成价格同步与重定价后再查看。</EmptyState>
          : <>
            <p className={styles.chartHint}>以下为只读表格形式的降级视图，便于无障碍读屏与窄屏阅读；上方为同名双曲线图表。</p>
            <DualLineChart dates={indexSeries.dates} series={indexSeries.series} ariaLabel={indexAria} />
            <IndexHistoryTable points={indexPoints} />
          </>}
    </section>

    <section className={styles.chartCard} aria-label="单卡价格历史">
      <h2>单卡价格历史</h2>
      <p className={styles.muted}>选择一张卡牌查看其参考价与游戏内报价的按日历史；空历史表示该 SKU 在所选范围内尚无快照，不代表查询失败。</p>
      <form className="catalog-filters" onSubmit={(event) => { event.preventDefault(); applySearch(); }}>
        <FilterBar>
          <label>名称<input aria-label="价格历史名称筛选" value={draft.query} onChange={(event) => setDraft({ ...draft, query: event.target.value })} /></label>
          <label>系列<input aria-label="价格历史系列筛选" value={draft.setCode} onChange={(event) => setDraft({ ...draft, setCode: event.target.value })} placeholder="例如 ONE" /></label>
          <label>稀有度<input aria-label="价格历史稀有度筛选" value={draft.rarity} onChange={(event) => setDraft({ ...draft, rarity: event.target.value })} placeholder="例如 rare" /></label>
          <label>工艺<select aria-label="价格历史工艺筛选" value={draft.finish} onChange={(event) => setDraft({ ...draft, finish: event.target.value as CardFinish | "" })}><option value="">全部</option>{finishes.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
          <button className="button" type="submit">搜索卡牌</button>
        </FilterBar>
      </form>
      {quotes.isError ? <p className={styles.stale} role="status">卡牌候选列表读取失败；请重试。</p> : null}
      {quotes.data && quotes.data.data.items.length > 0 ? (
        <div className={styles.skuList}>
          {quotes.data.data.items.map((item) => (
            <article key={item.sku.id} className={styles.skuRow} aria-pressed={skuIdParam === item.sku.id}>
              <div className={styles.skuRowName}>{item.sku.name}</div>
              <div className={styles.skuMeta}>{item.sku.setCode} · #{item.sku.collectorNumber} · {finishLabel(item.sku.finish)} · {item.sku.rarity}</div>
              <button type="button" className={styles.skuButton} onClick={() => selectSku(item)} aria-pressed={skuIdParam === item.sku.id}>{skuIdParam === item.sku.id ? "已选中" : "查看历史"}</button>
            </article>
          ))}
        </div>
      ) : quotes.data ? <EmptyState title="没有符合条件的价格历史候选">调整筛选条件或等待服务端完成价格同步。</EmptyState> : null}

      {skuIdParam ? (
        skuHistory.isError
          ? <ErrorState title="单卡价格历史读取失败" onRetry={() => void skuHistory.refetch()} />
          : skuPoints.length === 0
            ? <EmptyState title="该 SKU 暂无历史快照">所选时间范围内服务端尚无参考价或游戏内报价历史。</EmptyState>
            : <>
              <h3 className={styles.chartHint}>{selectedSku ? selectedSku.sku.name : "已选 SKU"} 的双曲线</h3>
              <DualLineChart dates={skuDates} series={skuSeries} ariaLabel={skuAria} />
              <SkuHistoryTable points={skuPoints} />
              <p className={styles.priceDisclaimer}>参考价来自 {skuHistory.data?.data.referenceSource === "mtgjson-cardmarket" ? "MTGJSON / Cardmarket EUR" : "暂无 MTGJSON 参考"}；游戏内价以虚拟货币游戏币表示，非实时、非真实资产。</p>
            </>
      ) : <p className={styles.muted}>从上方候选中选择一张卡牌，即可查看其价格历史。</p>}
    </section>
  </main>;
}
