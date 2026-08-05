"use client";

import type { MarketQuoteListItemDto, WatchlistItemDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import { useMarketQuotesQuery } from "../../api/market-api";
import { useWatchlistAlertsQuery, useWatchlistQuery, useWatchlistRemoveMutation, useWatchlistUpsertMutation, useMarkAlertReadMutation } from "../../api/watchlist-api";
import { useCatalogDetailQuery } from "../../api/catalog-api";
import { ConfirmDialog, EmptyState, ErrorState, FilterBar, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import styles from "./watchlist-page.module.css";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function targetTypeLabel(type: "game_price" | "reference_price"): string {
  return type === "game_price" ? "游戏内中间价" : "Cardmarket EUR 参考价";
}
function directionLabel(direction: "at_or_below" | "at_or_above"): string {
  return direction === "at_or_below" ? "≤ 跌到或低于" : "≥ 涨到或高于";
}
function skuHistoryHref(skuId: string): string {
  return `/market/history?skuId=${encodeURIComponent(skuId)}`;
}
/** 目标价展示：游戏内价按最小单位显示游戏币，参考价按 EUR 分显示欧元；只展示服务端保存值。 */
function targetValueText(item: { targetType: "game_price" | "reference_price"; targetAmount: number }): string {
  return item.targetType === "game_price"
    ? formatMoney({ amount: item.targetAmount, currency: "GAME_CREDIT" })
    : `€${(item.targetAmount / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

/** 条目行内只读卡名投影；名称来自本地目录详情，找不到时不阻断展示 SKU ID。 */
function WatchlistItemName({ skuId }: { skuId: string }) {
  const catalog = useCatalogDetailQuery(skuId);
  if (catalog.isPending) return <span aria-busy="true">正在加载卡名…</span>;
  if (catalog.isError || !catalog.data) return <span className={styles.secondary}>{skuId}</span>;
  return <Link className={styles.nameLink} href={skuHistoryHref(skuId)}>{catalog.data.data.sku.name}</Link>;
}

function WatchlistItemRow({ item, removing, onRemove, onToggle }: {
  item: WatchlistItemDto;
  removing: boolean;
  onRemove: () => void;
  onToggle: () => void;
}) {
  return <li className={styles.itemRow}>
    <div className={styles.itemMain}>
      <WatchlistItemName skuId={item.skuId} />
      <span className={styles.secondary}>SKU {item.skuId}</span>
    </div>
    <div className={styles.itemDetail}>
      <span>{targetTypeLabel(item.targetType)}</span>
      <span>{directionLabel(item.direction)} <strong className={styles.itemTarget}>{targetValueText(item)}</strong></span>
      <span className={styles.secondary}>创建于 {formatDate(item.createdAt)}</span>
    </div>
    <div className={styles.itemActions}>
      <span className={`${styles.stateChip} ${item.enabled ? styles.stateOn : styles.stateOff}`}>{item.enabled ? "启用中" : "已停用"}</span>
      <button className="button secondary" type="button" disabled={removing} onClick={onToggle}>{item.enabled ? "停用" : "启用"}</button>
      <button className="button secondary" type="button" disabled={removing} onClick={onRemove}>删除</button>
    </div>
  </li>;
}

/** I34F（I34B E12）价格提醒页：添加/删除/启停与已触达通知全部以服务端为准，命中判定不在浏览器执行。 */
export function WatchlistPage() {
  const watchlist = useWatchlistQuery();
  const alerts = useWatchlistAlertsQuery();
  const upsert = useWatchlistUpsertMutation();
  const remove = useWatchlistRemoveMutation();
  const markRead = useMarkAlertReadMutation();
  const [draftQuery, setDraftQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState<string | undefined>(undefined);
  const candidates = useMarketQuotesQuery({ query: searchQuery, limit: 20 });
  const [selected, setSelected] = useState<MarketQuoteListItemDto | null>(null);
  const [targetType, setTargetType] = useState<"game_price" | "reference_price">("game_price");
  const [direction, setDirection] = useState<"at_or_below" | "at_or_above">("at_or_below");
  const [targetAmount, setTargetAmount] = useState("");
  const [pendingRemove, setPendingRemove] = useState<WatchlistItemDto | null>(null);
  const [pendingToggle, setPendingToggle] = useState<WatchlistItemDto | null>(null);
  const [pendingAdd, setPendingAdd] = useState(false);
  const addLock = useRef(false);
  const removeLock = useRef(false);
  const toggleLock = useRef(false);
  const readLock = useRef(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const items = watchlist.data?.data.items ?? [];
  const limits = watchlist.data?.data.limits;
  const alertItems = alerts.data?.data.items ?? [];
  const unreadCount = alerts.data?.data.unreadCount ?? 0;
  const upsertPending = upsert.isPending;
  const removePending = remove.isPending;
  const markReadPending = markRead.isPending;
  const searchResults = useMemo(() => candidates.data?.data.items ?? [], [candidates.data]);

  const upsertError = upsert.error instanceof ApiClientError ? upsert.error.message : upsert.isError ? "保存价格提醒未完成，请重试。" : null;

  const parseTarget = (): number | null => {
    const value = Number(targetAmount);
    if (!Number.isInteger(value) || value < 0) return null;
    return value;
  };

  const confirmAdd = () => {
    if (!selected || upsertPending || addLock.current) return;
    const amount = parseTarget();
    if (amount === null) { setAddError("目标价必须是不小于 0 的整数（最小货币单位）。"); setPendingAdd(false); return; }
    setAddError(null);
    addLock.current = true;
    upsert.mutate({ skuId: selected.sku.id, targetType, direction, targetAmount: amount, enabled: true }, {
      onSuccess: () => { addLock.current = false; setPendingAdd(false); setSelected(null); setTargetAmount(""); setSearchQuery(undefined); setDraftQuery(""); },
      onError: () => { addLock.current = false; setPendingAdd(false); }
    });
  };

  const confirmRemove = () => {
    if (!pendingRemove || removePending || removeLock.current) return;
    setRemoveError(null);
    removeLock.current = true;
    remove.mutate({ skuId: pendingRemove.skuId }, {
      onSuccess: () => { removeLock.current = false; setPendingRemove(null); },
      onError: (error) => { removeLock.current = false; setRemoveError(error instanceof Error ? error.message : "删除价格提醒未完成。"); setPendingRemove(null); }
    });
  };

  const confirmToggle = () => {
    if (!pendingToggle || upsertPending || toggleLock.current) return;
    setToggleError(null);
    toggleLock.current = true;
    upsert.mutate({ skuId: pendingToggle.skuId, targetType: pendingToggle.targetType, direction: pendingToggle.direction, targetAmount: pendingToggle.targetAmount, enabled: !pendingToggle.enabled }, {
      onSuccess: () => { toggleLock.current = false; setPendingToggle(null); },
      onError: (error) => { toggleLock.current = false; setToggleError(error instanceof Error ? error.message : "更新价格提醒未完成。"); setPendingToggle(null); }
    });
  };

  const confirmRead = (alertId: string) => {
    if (markReadPending || readLock.current) return;
    readLock.current = true;
    markRead.mutate({ alertId }, {
      onSettled: () => { readLock.current = false; }
    });
  };

  if (watchlist.isPending) return <PageSkeleton label="正在加载价格提醒" />;
  if (watchlist.isError) return <main className="page"><ErrorState title="价格提醒加载失败" onRetry={() => void watchlist.refetch()} /></main>;

  return <main className="page watchlist-page">
    <p className="eyebrow">服务端目标价提醒</p>
    <h1>价格提醒</h1>
    <p className="intro">目标价、方向与命中判定全部由服务端保存并执行：价格刷新后由服务端任务按最新报价快照判定，命中后生成站内提醒。页面只提交意图，不计算报价、不重判命中。</p>

    <section className={styles.sectionCard} aria-labelledby="alerts-title">
      <div className={styles.sectionHead}>
        <h2 id="alerts-title">已触达提醒</h2>
        {unreadCount > 0 ? <span className={styles.unreadChip} role="status">未读 {unreadCount}</span> : <span className={styles.secondary}>全部已读</span>}
      </div>
      {alerts.isPending ? <p aria-busy="true">正在加载提醒…</p>
        : alerts.isError ? <p className={styles.inlineError}>{alerts.error instanceof Error ? alerts.error.message : "提醒加载失败。"}<button className="button secondary" type="button" onClick={() => void alerts.refetch()}>重试</button></p>
        : alertItems.length === 0 ? <EmptyState title="暂无价格提醒">目标价被服务端判定触达后，提醒会出现在这里。</EmptyState>
        : <ul className={styles.alertList}>{alertItems.map((alert) => (
          <li key={alert.id} className={`${styles.alertRow} ${alert.read ? "" : styles.alertUnread}`}>
            <div className={styles.alertMain}>
              <WatchlistItemName skuId={alert.skuId} />
              <span className={styles.secondary}>{targetTypeLabel(alert.targetType)} {directionLabel(alert.direction)} {targetValueText(alert)}</span>
            </div>
            <div className={styles.alertDetail}>
              <span>触发价 {alert.targetType === "game_price" ? formatMoney({ amount: alert.triggeredPrice, currency: "GAME_CREDIT" }) : `€${(alert.triggeredPrice / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`}</span>
              <span className={styles.secondary}>{formatDate(alert.triggeredAt)}</span>
              <span className={styles.secondary}>{alert.read ? "已读" : "未读"}</span>
            </div>
            <div className={styles.alertActions}>
              {alert.read ? null : <button className="button secondary" type="button" disabled={markReadPending} onClick={() => confirmRead(alert.id)}>标记已读</button>}
              <Link className="text-button" href={skuHistoryHref(alert.skuId)}>查看价格历史 →</Link>
            </div>
          </li>
        ))}</ul>}
    </section>

    <section className={styles.sectionCard} aria-labelledby="add-title">
      <h2 id="add-title">添加价格提醒</h2>
      <p className={styles.secondary}>当前上限 {limits?.maxItemsPerUser ?? 50} 条（每 SKU 一条）；添加或更新都只保存你确认的目标价与方向。</p>
      <form className="catalog-filters" onSubmit={(event) => { event.preventDefault(); setSearchQuery(draftQuery.trim() || undefined); }}>
        <FilterBar>
          <label>搜索卡牌<input aria-label="搜索卡牌" value={draftQuery} onChange={(event) => setDraftQuery(event.target.value)} placeholder="输入卡名" /></label>
          <button className="button" type="submit">搜索</button>
          <button className="button secondary" type="button" onClick={() => { setSearchQuery(undefined); setDraftQuery(""); setSelected(null); }}>清除</button>
        </FilterBar>
      </form>
      {candidates.isError ? <p className={styles.inlineError}>卡牌候选加载失败；请重试。</p> : null}
      {searchQuery && !selected ? (
        searchResults.length === 0 && !candidates.isPending ? <p className={styles.secondary}>没有找到符合条件的卡牌。</p>
          : <ul className={styles.candidateList}>{searchResults.map((item) => (
            <li key={item.sku.id}><button type="button" className={styles.candidateButton} onClick={() => { setSelected(item); setAddError(null); setTargetAmount(item.quote?.marketPrice.amount !== undefined ? String(item.quote.marketPrice.amount) : ""); }}>{item.sku.name}（{item.sku.setCode} #{item.sku.collectorNumber} · {item.sku.finish}）</button></li>
          ))}</ul>
      ) : null}
      {selected ? <div className={styles.addForm}>
        <p>已选择：<strong>{selected.sku.name}</strong>（{selected.sku.setCode} #{selected.sku.collectorNumber} · {selected.sku.finish}）</p>
        <div className={styles.addGrid}>
          <label>目标价格类型<select aria-label="目标价格类型" value={targetType} onChange={(event) => setTargetType(event.target.value as "game_price" | "reference_price")}><option value="game_price">游戏内中间价</option><option value="reference_price">Cardmarket EUR 参考价</option></select></label>
          <label>方向<select aria-label="提醒方向" value={direction} onChange={(event) => setDirection(event.target.value as "at_or_below" | "at_or_above")}><option value="at_or_below">跌到或低于（≤）</option><option value="at_or_above">涨到或高于（≥）</option></select></label>
          <label>目标价{targetType === "game_price" ? "（游戏币）" : "（EUR 分）"}<input aria-label="目标价" type="number" min="0" step="1" value={targetAmount} onChange={(event) => setTargetAmount(event.target.value)} /></label>
        </div>
        {addError ? <p className={styles.inlineError} role="alert">{addError}</p> : null}
        {upsertError ? <p className={styles.inlineError} role="alert">{upsertError}<button className="button secondary" type="button" onClick={() => { upsert.beginNewIntent(); setPendingAdd(false); }}>重试</button></p> : null}
        <div className="actions">
          <button className="button secondary" type="button" disabled={upsertPending} onClick={() => setSelected(null)}>取消选择</button>
          <button className="button" type="button" disabled={upsertPending} onClick={() => setPendingAdd(true)}>{upsertPending ? "正在保存…" : "确认添加提醒"}</button>
        </div>
      </div> : null}
    </section>

    <section className={styles.sectionCard} aria-labelledby="items-title">
      <div className={styles.sectionHead}><h2 id="items-title">我的提醒列表</h2><span className={styles.secondary}>{items.length} / {limits?.maxItemsPerUser ?? 50}</span></div>
      {removeError ? <p className={styles.inlineError} role="alert">{removeError}</p> : null}
      {toggleError ? <p className={styles.inlineError} role="alert">{toggleError}</p> : null}
      {items.length === 0 ? <EmptyState title="还没有价格提醒">在上方搜索卡牌并设置目标价后，服务端会在价格触达时生成提醒。</EmptyState>
        : <ul className={styles.itemList}>{items.map((item) => <WatchlistItemRow key={item.id} item={item} removing={removePending} onRemove={() => setPendingRemove(item)} onToggle={() => setPendingToggle(item)} />)}</ul>}
    </section>

    <ConfirmDialog open={pendingAdd} title="确认添加价格提醒" description={selected ? `将提醒「${selected.sku.name}」的目标价设为 ${targetType === "game_price" ? `${targetAmount} 游戏币` : `€${(Number(targetAmount) / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`}（${directionLabel(direction)}，${targetTypeLabel(targetType)}）。命中与提醒由服务端判定。是否确认？` : "请先选择卡牌。"} onCancel={() => { setPendingAdd(false); setAddError(null); }} onConfirm={confirmAdd} />
    <ConfirmDialog open={pendingRemove !== null} title="确认删除价格提醒" description={pendingRemove ? `将删除 SKU ${pendingRemove.skuId} 的目标价提醒及其历史提醒记录。是否确认？` : ""} onCancel={() => setPendingRemove(null)} onConfirm={confirmRemove} />
    <ConfirmDialog open={pendingToggle !== null} title={pendingToggle?.enabled ? "确认停用价格提醒" : "确认启用价格提醒"} description={pendingToggle ? `将${pendingToggle.enabled ? "停用" : "启用"} SKU ${pendingToggle.skuId} 的价格提醒；停用后服务端不再判定该条目触达。是否确认？` : ""} onCancel={() => setPendingToggle(null)} onConfirm={confirmToggle} />
  </main>;
}
