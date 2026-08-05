"use client";

import type { MarketAnnouncementDto, MarketHeatDto, MarketHeatEntryDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useMarketIndexHistoryQuery } from "../../api/market-api";
import { formatMoney } from "../../utils/money";
import { formatBasisPoints } from "../../utils/percent";
import styles from "./market-page.module.css";

function skuHistoryHref(skuId: string): string {
  return `/market/history?skuId=${encodeURIComponent(skuId)}`;
}
function finishLabel(finish: string): string {
  return finish === "foil" ? "闪" : finish === "etched" ? "蚀刻" : "非闪";
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** 涨跌方向徽标：只展示服务端计算的幅度与方向，浏览器不重算。 */
function ChangeBadge({ entry }: { entry: MarketHeatEntryDto }) {
  if (entry.direction === "flat") return <span className={`${styles.changeBadge} ${styles.changeFlat}`}>持平</span>;
  const up = entry.direction === "up";
  return <span className={`${styles.changeBadge} ${up ? styles.changeUp : styles.changeDown}`} aria-label={`${up ? "上涨" : "下跌"} ${formatBasisPoints(entry.changeBasisPoints)}`}>
    {up ? "▲" : "▼"} {formatBasisPoints(entry.changeBasisPoints)}
  </span>;
}

/** 涨跌榜单行：卡名与现价可点击进入该 SKU 价格历史页，方向/幅度来自服务端。 */
function HeatEntryRow({ entry, label }: { entry: MarketHeatEntryDto; label: string }) {
  return (
    <li className={styles.heatRow}>
      <div className={styles.heatRowMain}>
        <Link className={styles.heatName} href={skuHistoryHref(entry.sku.id)}>{entry.sku.name}</Link>
        <span className={styles.muted}>{entry.sku.setCode} · #{entry.sku.collectorNumber} · {finishLabel(entry.sku.finish)}</span>
      </div>
      <div className={styles.heatRowPrice}>
        <Link className={styles.heatPrice} href={skuHistoryHref(entry.sku.id)}>{formatMoney(entry.currentPrice)}</Link>
        <ChangeBadge entry={entry} />
      </div>
      <span className={styles.muted} aria-label={`${label}基准价`}>{entry.basePrice ? `基准 ${formatMoney(entry.basePrice)}` : "暂无基准报价"}</span>
    </li>
  );
}

function HeatList({ title, entries, empty, label }: { title: string; entries: MarketHeatEntryDto[]; empty: string; label: string }) {
  return <section className={styles.heatPanel} aria-label={title}>
    <h3>{title}</h3>
    {entries.length === 0 ? <p className={styles.muted}>{empty}</p> : <ul className={styles.heatList}>{entries.map((entry) => <HeatEntryRow key={entry.sku.id} entry={entry} label={label} />)}</ul>}
  </section>;
}

/** 最活跃交易榜：当日已结算 NPC/P2P 成交（数量与金额）由服务端聚合，浏览器不统计。 */
function MostActiveList({ entries }: { entries: MarketHeatDto["mostActive"] }) {
  return <section className={styles.heatPanel} aria-label="当日最活跃交易">
    <h3>当日最活跃交易</h3>
    {entries.length === 0 ? <p className={styles.muted}>今日尚无已结算成交。</p> : <ul className={styles.heatList}>{entries.map((item) => (
      <li key={item.sku.id} className={styles.heatRow}>
        <div className={styles.heatRowMain}>
          <Link className={styles.heatName} href={skuHistoryHref(item.sku.id)}>{item.sku.name}</Link>
          <span className={styles.muted}>{item.sku.setCode} · #{item.sku.collectorNumber}</span>
        </div>
        <div className={styles.heatRowPrice}>
          <span>成交 {item.quantity} 张</span>
          <span className={styles.muted}>金额 {formatMoney(item.turnover)}</span>
        </div>
      </li>
    ))}</ul>}
  </section>;
}

/** 游戏内指数迷你走势条：复用 I17F 指数历史端点（7 日），只展示服务端采样点，不插值。 */
function IndexSparkline() {
  const history = useMarketIndexHistoryQuery("7d");
  const points = history.data?.data.points ?? [];
  const values = points.map((point) => point.gameIndex).filter((value): value is number => value !== null);
  const latest = values.at(-1);
  if (history.isError) return <div className={styles.sparklineBox}><span className={styles.muted}>指数走势暂不可读取。</span></div>;
  if (points.length === 0) return <div className={styles.sparklineBox}><span className={styles.muted}>暂无游戏内指数历史。</span></div>;
  if (values.length < 2) return <div className={styles.sparklineBox}><span className={styles.muted}>游戏内指数历史点不足，暂无法绘制走势。</span>{latest !== undefined ? <strong className={styles.sparklineValue}>{formatMoney({ amount: latest, currency: "GAME_CREDIT" })}</strong> : null}</div>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = 100 / (values.length - 1);
  const pointsText = values.map((value, index) => `${(index * stepX).toFixed(2)},${(30 - ((value - min) / range) * 26 - 2).toFixed(2)}`).join(" ");
  const aria = latest === undefined ? "" : `游戏内市场指数迷你走势，覆盖 ${points.length} 个自然日；当前 ${formatMoney({ amount: latest, currency: "GAME_CREDIT" })}，期间最低 ${formatMoney({ amount: min, currency: "GAME_CREDIT" })}、最高 ${formatMoney({ amount: max, currency: "GAME_CREDIT" })}。`;
  return <div className={styles.sparklineBox}>
    <div className={styles.sparklineHead}><span>游戏内指数迷你走势（近 7 日）</span><strong className={styles.sparklineValue}>{formatMoney({ amount: latest!, currency: "GAME_CREDIT" })}</strong></div>
    <svg className={styles.sparkline} viewBox="0 0 100 32" preserveAspectRatio="none" role="img" aria-label={aria}>
      <polyline points={pointsText} fill="none" stroke="var(--accent-gold-bright)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  </div>;
}

/** I34F：行情屏（涨跌榜 + 活跃榜 + 迷你走势条）。所有数字均为服务端聚合，浏览器不计算涨跌。 */
export function MarketHeatBoard({ heat }: { heat: MarketHeatDto }) {
  return <section className={styles.heatBoard} aria-labelledby="heat-board-title">
    <div className={styles.heatHeader}>
      <h2 id="heat-board-title">行情屏</h2>
      <span className={styles.muted}>数据截至 {formatDate(heat.capturedAt)}；涨跌幅度由服务端按报价快照计算。</span>
    </div>
    <IndexSparkline />
    <div className={styles.heatGrid}>
      <HeatList title="日内涨幅榜" entries={heat.intradayGainers} empty="日内暂无上涨报价。" label="日内" />
      <HeatList title="日内跌幅榜" entries={heat.intradayLosers} empty="日内暂无下跌报价。" label="日内" />
      <HeatList title="7 日涨幅榜" entries={heat.sevenDayGainers} empty="近 7 日暂无上涨报价。" label="7 日" />
      <HeatList title="7 日跌幅榜" entries={heat.sevenDayLosers} empty="近 7 日暂无下跌报价。" label="7 日" />
    </div>
    <MostActiveList entries={heat.mostActive} />
  </section>;
}

function scopeLabel(scope: MarketAnnouncementDto["scope"]): string {
  return scope === "global" ? "全服" : scope === "set" ? "系列" : "单卡";
}

/** I34F：系列周期与市场活动公告区。只展示服务端标题/范围/生效区间，不暴露内部系数；系列公告可跳转对应系列目录。 */
export function AnnouncementsSection({ items }: { items: MarketAnnouncementDto[] }) {
  return <section className={styles.announceSection} aria-labelledby="announce-title">
    <h2 id="announce-title">市场公告</h2>
    {items.length === 0 ? <p className={styles.muted}>当前没有生效中的系列周期或市场活动公告。</p> : <ul className={styles.announceList}>
      {items.map((item, index) => (
        <li key={`${item.type}-${index}`} className={styles.announceItem}>
          <div className={styles.announceHead}>
            <strong>{item.type === "series_cycle" ? "系列周期" : "市场活动"}：{item.title}</strong>
            <span className={styles.announceScope}>{scopeLabel(item.scope)}</span>
          </div>
          <p className={styles.muted}>{item.reason}</p>
          <p className={styles.muted}>生效区间：{formatDate(item.startsAt)} — {formatDate(item.endsAt)}</p>
          {item.scope === "set" && item.setCode ? <Link className="text-button" href={`/catalog?setCode=${encodeURIComponent(item.setCode)}`}>查看系列 {item.setCode} 卡牌 →</Link> : null}
          {item.scope === "sku" && item.skuName ? <span className={styles.muted}>影响卡牌：{item.skuName}</span> : null}
        </li>
      ))}
    </ul>}
  </section>;
}

/** I34F：市场叙事横幅。只展示服务端返回的 NPC 倾向报价原因（不含系数），按文案去重，不显示则不伪造。 */
export function NarrativeBanner({ quotes }: { quotes: Array<{ quote: { reasons: Array<{ kind: string; reason: string }> } } | { quote: null }> }) {
  const reasons = Array.from(new Set(
    quotes
      .flatMap((item) => (item.quote ? item.quote.reasons.filter((reason) => reason.kind === "bias").map((reason) => reason.reason) : []))
      .filter((reason) => reason.length > 0)
  ));
  if (reasons.length === 0) return null;
  return <section className={styles.narrativeBanner} role="status" aria-label="市场叙事">
    <h2>市场叙事</h2>
    <p>服务端 NPC 做市商倾向：{reasons.join("；")}（仅展示报价原因文案，不含内部系数）。</p>
  </section>;
}
