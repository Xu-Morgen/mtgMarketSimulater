"use client";

import { Pagination as AntPagination, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { BilateralOrderDto, OrderSide, OrderStatus, PlayerBilateralTradeDto } from "@mtg-market/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useArchiveQuery } from "../../api/archive-api";
import { type OrdersFilters, useCancelOrderMutation, useOrderBookQuery, useOrdersQuery, usePlayerTradesQuery } from "../../api/orders-api";
import { ConfirmDialog, EmptyState, ErrorState, FilterBar, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import styles from "./orders-page.module.css";

const defaultPageSize = 20;
const pageSizeOptions = [20, 50, 100];
const statusOptions: Array<{ value: OrderStatus; label: string; color: string }> = [
  { value: "open", label: "挂单中", color: "green" },
  { value: "partially_filled", label: "部分成交", color: "gold" },
  { value: "matched_pending_fulfillment", label: "待履约", color: "orange" },
  { value: "fulfilled", label: "已完成", color: "blue" },
  { value: "cancelled", label: "已撤单", color: "default" },
  { value: "expired", label: "已过期", color: "default" }
];
const sideOptions: Array<{ value: OrderSide; label: string; color: string }> = [{ value: "buy", label: "买单", color: "green" }, { value: "sell", label: "卖单", color: "volcano" }];

function statusLabel(status: OrderStatus): { label: string; color: string } {
  return statusOptions.find((option) => option.value === status) ?? { label: status, color: "default" };
}
function sideLabel(side: OrderSide): { label: string; color: string } {
  return sideOptions.find((option) => option.value === side) ?? { label: side, color: "default" };
}
function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function feeAmount(order: BilateralOrderDto, kind: "order_fee" | "fulfillment_deposit"): number {
  return order.fees.find((fee) => fee.kind === kind)?.amount.amount ?? 0;
}
function filtersFromSearch(search: URLSearchParams | null): OrdersFilters {
  const value = search ?? new URLSearchParams();
  const requestedLimit = Number.parseInt(value.get("limit") ?? "", 10);
  const status = value.get("status");
  const side = value.get("side");
  return {
    status: statusOptions.some((option) => option.value === status) ? (status as OrderStatus) : undefined,
    side: side === "buy" || side === "sell" ? side : undefined,
    cursor: value.get("cursor") || undefined,
    limit: pageSizeOptions.includes(requestedLimit) ? requestedLimit : defaultPageSize
  };
}
function toUrl(filters: OrdersFilters, bookSkuId?: string): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value && !(key === "limit" && value === defaultPageSize)) search.set(key, String(value));
  if (bookSkuId) search.set("skuId", bookSkuId);
  const suffix = search.toString();
  return suffix ? `/orders?${suffix}` : "/orders";
}
function isCancellable(order: BilateralOrderDto): boolean {
  return order.status === "open" || order.status === "partially_filled";
}

/** 我的委托页面投影服务端订单状态、双边订单簿、成交与待履约资产；所有金额与状态均来自服务端。 */
export function OrdersPage() {
  const router = useRouter();
  const search = useSearchParams();
  const filters = filtersFromSearch(search);
  const urlSkuId = search?.get("skuId") ?? undefined;
  const archive = useArchiveQuery();
  const orders = useOrdersQuery(filters);
  const cancel = useCancelOrderMutation();
  const [pendingCancel, setPendingCancel] = useState<BilateralOrderDto | null>(null);
  const [cancelledOrder, setCancelledOrder] = useState<BilateralOrderDto | null>(null);
  const [cancelConflict, setCancelConflict] = useState<string | null>(null);
  const pageSize = filters.limit ?? defaultPageSize;
  const currentPage = Math.floor(Number.parseInt(filters.cursor ?? "0", 10) / pageSize) + 1;

  // 订单簿默认 SKU：URL ?skuId= 优先；否则取最近一笔未完成委托的 SKU，再次回退到最近一笔成交的 SKU。
  const trades = usePlayerTradesQuery({ limit: 20 });
  const defaultBookSkuId = useMemo(() => {
    if (urlSkuId) return urlSkuId;
    const recentOrder = orders.data?.data.items.find((order) => isCancellable(order) || order.status === "matched_pending_fulfillment");
    if (recentOrder) return recentOrder.skuId;
    return trades.data?.data.items.at(0)?.skuId ?? null;
  }, [urlSkuId, orders.data?.data.items, trades.data?.data.items]);
  const [bookSkuId, setBookSkuId] = useState<string | null>(null);
  const selectedBookSkuId = bookSkuId ?? defaultBookSkuId;
  const book = useOrderBookQuery(selectedBookSkuId);

  const columns = useMemo<ColumnsType<BilateralOrderDto>>(() => [
    { title: "方向", key: "side", render: (_, order) => { const meta = sideLabel(order.side); return <Tag color={meta.color}>{meta.label}</Tag>; } },
    { title: "状态", key: "status", render: (_, order) => { const meta = statusLabel(order.status); return <Tag color={meta.color}>{meta.label}</Tag>; } },
    { title: "SKU", dataIndex: "skuId", key: "sku", render: (skuId: string) => <span className={styles.secondary}>{skuId}</span> },
    { title: "数量", key: "quantity", render: (_, order) => <div><div>剩余 {order.remainingQuantity}</div><span className={styles.secondary}>原始 {order.originalQuantity}</span></div> },
    { title: "限价", key: "limitPrice", render: (_, order) => formatMoney(order.limitPrice) },
    { title: "服务端费用", key: "fees", render: (_, order) => <div><div>order_fee {formatMoney({ amount: feeAmount(order, "order_fee"), currency: "GAME_CREDIT" })}</div><div>fulfillment_deposit {formatMoney({ amount: feeAmount(order, "fulfillment_deposit"), currency: "GAME_CREDIT" })}</div></div> },
    { title: "预占资金", key: "reservedFunds", render: (_, order) => order.reservedFunds ? formatMoney(order.reservedFunds) : <Tag color="default">无</Tag> },
    { title: "锁定库存", dataIndex: "reservedInventoryQuantity", key: "reservedInventory" },
    { title: "到期时间", key: "expiresAt", render: (_, order) => formatDate(order.expiresAt) },
    { title: "版本", dataIndex: "version", key: "version" },
    { title: "创建时间", key: "createdAt", render: (_, order) => formatDate(order.createdAt) },
    { title: "操作", key: "action", render: (_, order) => isCancellable(order) ? <button type="button" className="button secondary" onClick={() => { setCancelConflict(null); setPendingCancel(order); }}>撤单</button> : <Tag color="default">不可撤单</Tag> }
  ], []);

  const tradeColumns = useMemo<ColumnsType<PlayerBilateralTradeDto>>(() => [
    { title: "我的角色", key: "role", render: (_, trade) => <Tag color={trade.role === "buyer" ? "green" : "volcano"}>{trade.role === "buyer" ? "买方" : "卖方"}</Tag> },
    { title: "SKU", dataIndex: "skuId", key: "sku", render: (skuId: string) => <span className={styles.secondary}>{skuId}</span> },
    { title: "数量", dataIndex: "quantity", key: "quantity" },
    { title: "成交价", key: "executionPrice", render: (_, trade) => formatMoney(trade.executionPrice) },
    { title: "我的 order_fee", key: "fee", render: (_, trade) => formatMoney(trade.fee) },
    { title: "待履约资金", key: "pendingFunds", render: (_, trade) => trade.pendingFunds ? formatMoney(trade.pendingFunds) : <Tag color="default">无</Tag> },
    { title: "待履约库存", key: "pendingInventory", render: (_, trade) => trade.pendingInventoryQuantity ?? "—" },
    { title: "状态", key: "status", render: () => <Tag color="orange">待履约</Tag> },
    { title: "规则版本", dataIndex: "ruleVersion", key: "ruleVersion", render: (value: string) => <span className={styles.secondary}>{value}</span> },
    { title: "成交时间", key: "createdAt", render: (_, trade) => formatDate(trade.createdAt) }
  ], []);

  const confirmCancel = () => {
    if (!pendingCancel) return;
    const orderId = pendingCancel.id;
    cancel.mutate({ orderId }, {
      onSuccess: ({ data }) => { setPendingCancel(null); setCancelledOrder(data.order); },
      onError: (error) => {
        const message = error instanceof Error ? error.message : "撤单未完成，请刷新后重试。";
        setCancelConflict(message);
        setPendingCancel(null);
      }
    });
  };

  if (orders.isPending) return <PageSkeleton label="正在加载我的委托" />;
  if (orders.isError) return <main className="page"><ErrorState title="我的委托加载失败" onRetry={() => void orders.refetch()} /></main>;
  const page = orders.data.data;
  const total = page.page.total ?? (currentPage - 1) * pageSize + page.items.length + (page.page.hasMore ? 1 : 0);
  const apply = (next: Partial<Pick<OrdersFilters, "status" | "side">>) => router.push(toUrl({ ...filters, ...next, cursor: undefined }, selectedBookSkuId ?? undefined));
  const balance = archive.data?.data.archive.balance;

  // 待履约资产摘要：聚合成交行的待履约资金与库存（仅展示，不结算）。
  const tradeItems = trades.data?.data.items ?? [];
  const pendingFulfillmentTrades = tradeItems.filter((trade) => trade.status === "matched_pending_fulfillment");
  const pendingFundsTotal = pendingFulfillmentTrades.reduce((sum, trade) => sum + (trade.pendingFunds?.amount ?? 0), 0);
  const pendingInventoryTotal = pendingFulfillmentTrades.reduce((sum, trade) => sum + (trade.pendingInventoryQuantity ?? 0), 0);
  const skuOptions = Array.from(new Set(page.items.map((order) => order.skuId)));

  const selectBookSku = (nextSkuId: string) => {
    setBookSkuId(nextSkuId || null);
    router.replace(toUrl(filters, nextSkuId || undefined));
  };
  const bookData = book.data?.data.book;

  return <main className="page orders-page">
    <p className="eyebrow">服务端订单与撮合状态投影</p>
    <h1>我的委托</h1>
    <p className="intro">委托、限价、费用、保证金、预占资金、订单簿、成交与待履约资产均来自服务端。撮合状态、成交与待履约资产由服务端投影；履约确认/取消与到期回收将在 I20B/I20F/I22B 上线。</p>

    {balance ? <section className={styles.sectionCard} aria-label="账户余额状态">
      <h2>余额状态</h2>
      <div className={styles.balanceGrid}>
        <article><span>总额</span><strong>{formatMoney(balance.total)}</strong></article>
        <article><span>可用额</span><strong>{formatMoney(balance.available)}</strong></article>
        <article><span>冻结额</span><strong>{formatMoney(balance.frozen)}</strong></article>
      </div>
      <p className={styles.secondary}>撮合会把已成交部分的资金/保证金从「预占」转为「待履约持有」，冻结额随之变化；最终所有权转移在 I20B 履约时发生。</p>
    </section> : null}

    <section className={styles.sectionCard} aria-label="双边订单簿">
      <h2>双边订单簿</h2>
      <div className={styles.bookSelector}>
        <label>选择 SKU
          <select aria-label="订单簿 SKU" value={selectedBookSkuId ?? ""} onChange={(event) => selectBookSku(event.target.value)}>
            {skuOptions.length === 0 ? <option value="">暂无可选 SKU</option> : skuOptions.map((skuId) => <option value={skuId} key={skuId}>{skuId}</option>)}
          </select>
        </label>
        {selectedBookSkuId ? <button className="button secondary" type="button" onClick={() => selectBookSku("")}>清除选择</button> : null}
      </div>
      {!selectedBookSkuId ? <EmptyState title="尚未选择订单簿 SKU">默认选择你最近一笔未完成委托的 SKU；也可在上方下拉手动切换。</EmptyState>
        : book.isPending ? <p aria-busy="true">正在加载订单簿…</p>
        : book.isError ? <section className={styles.staleHint} role="status"><p>订单簿数据可能过期，连接失败，正在重试。</p><button className="button secondary" type="button" onClick={() => void book.refetch()}>立即刷新</button></section>
        : <><div className={styles.bookGrid}>
          <div className={styles.bookSide}><h3>买单（价格降序）</h3><BookLevels rows={bookData?.bids ?? []} emptyHint="无买单" /></div>
          <div className={styles.bookSide}><h3>卖单（价格升序）</h3><BookLevels rows={bookData?.asks ?? []} emptyHint="无卖单" /></div>
        </div>
        <p className={styles.bookMeta}>订单簿数据截至 {formatDate(bookData?.capturedAt ?? new Date().toISOString())}；价格—时间优先顺序由服务端返回，不含用户身份。页面每 10 秒自动刷新；切到后台不轮询。</p></>}
    </section>

    <section className={styles.sectionCard} aria-label="我的成交与待履约资产">
      <h2>我的成交与待履约资产</h2>
      {trades.isPending ? <p aria-busy="true">正在加载成交记录…</p>
      : trades.isError ? <section className={styles.staleHint} role="status"><p>成交数据可能过期，连接失败，正在重试。</p><button className="button secondary" type="button" onClick={() => void trades.refetch()}>立即刷新</button></section>
      : <>
        {pendingFulfillmentTrades.length > 0 ? <section className={styles.pendingSummary} role="status">
          <p>你有 <strong>{pendingFulfillmentTrades.length}</strong> 笔待履约成交：待履约资金 <strong>{formatMoney({ amount: pendingFundsTotal, currency: "GAME_CREDIT" })}</strong>{pendingInventoryTotal > 0 ? `、待履约库存 ${pendingInventoryTotal} 张` : ""}。</p>
          <p className={styles.secondary}>待履约资产由服务端撮合转入，本期只展示；履约确认/取消将在 I20B/I20F 上线。</p>
        </section> : null}
        {tradeItems.length === 0 ? <EmptyState title="没有成交记录">撮合产生成交后，这里会按服务端状态展示你的角色、成交价、费用与待履约资产。</EmptyState>
        : <div className={styles.tableWrap}><Table columns={tradeColumns} dataSource={tradeItems} rowKey="id" pagination={false} scroll={{ x: 1080 }} /></div>}
      </>}
    </section>

    {cancelledOrder ? <section className={styles.tradeSuccess} role="status"><h2>撤单已完成</h2><p>服务端已撤销委托，状态为「{statusLabel(cancelledOrder.status).label}」；{cancelledOrder.side === "buy" ? `释放预占资金 ${formatMoney(cancelledOrder.reservedFunds ?? { amount: 0, currency: "GAME_CREDIT" })}` : `解锁库存 ${cancelledOrder.reservedInventoryQuantity} 张、释放履约保证金 ${formatMoney(cancelledOrder.fulfillmentDeposit ?? { amount: 0, currency: "GAME_CREDIT" })}`}。余额、库存、账本与市场状态正在按服务器响应刷新。</p></section> : null}
    {cancelConflict ? <section className={styles.inlineError} role="status"><p>{cancelConflict}</p><button className="button secondary" type="button" onClick={() => { setCancelConflict(null); void orders.refetch(); }}>刷新委托列表</button></section> : null}
    <form className="catalog-filters" onSubmit={(event) => { event.preventDefault(); apply({ status: filters.status, side: filters.side }); }}>
      <FilterBar>
        <label>方向<select aria-label="委托方向筛选" value={filters.side ?? ""} onChange={(event) => apply({ side: (event.target.value || undefined) as OrdersFilters["side"] })}><option value="">全部</option>{sideOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        <label>状态<select aria-label="委托状态筛选" value={filters.status ?? ""} onChange={(event) => apply({ status: (event.target.value || undefined) as OrdersFilters["status"] })}><option value="">全部</option>{statusOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label>
        <button className="button secondary" type="button" onClick={() => router.push("/orders")}>清除</button>
      </FilterBar>
    </form>
    {page.items.length === 0 ? <EmptyState title="没有委托记录">尚未创建符合当前条件的买单或卖单。可在市场页挂买单、在库存页挂卖单。</EmptyState> : <>
      <div className={styles.tableWrap}><Table columns={columns} dataSource={page.items} rowKey="id" pagination={false} scroll={{ x: 1320 }} /></div>
      <div className={styles.pagination}><AntPagination current={currentPage} pageSize={pageSize} total={total} showSizeChanger showQuickJumper pageSizeOptions={pageSizeOptions} showTotal={(count, range) => `第 ${range[0]}–${range[1]} 项，共 ${count} 项`} onChange={(nextPage, nextPageSize) => { const nextLimit = Number(nextPageSize); const changedSize = nextLimit !== pageSize; router.push(toUrl({ ...filters, limit: nextLimit, cursor: changedSize || nextPage === 1 ? undefined : String((nextPage - 1) * nextLimit) }, selectedBookSkuId ?? undefined)); }} /></div>
    </>}
    <ConfirmDialog open={pendingCancel !== null} title="确认撤单" description={pendingCancel ? `将撤销该${pendingCancel.side === "buy" ? "买单" : "卖单"}并释放预占资金${pendingCancel.side === "buy" ? ` ${formatMoney(pendingCancel.reservedFunds ?? { amount: 0, currency: "GAME_CREDIT" })}` : pendingCancel.reservedInventoryQuantity > 0 ? `、解锁库存 ${pendingCancel.reservedInventoryQuantity} 张` : ""}；已成交部分不会被释放。是否继续？` : ""} onCancel={() => setPendingCancel(null)} onConfirm={confirmCancel} />
  </main>;
}

/** 订单簿档位只读展示；价格、剩余数量与委托数全部由服务端聚合返回。 */
function BookLevels({ rows, emptyHint }: { rows: Array<{ limitPrice: { amount: number }; remainingQuantity: number; orderCount: number }>; emptyHint: string }) {
  if (rows.length === 0) return <p className={styles.secondary}>{emptyHint}</p>;
  return <table>
    <thead><tr><th>限价</th><th>剩余数量</th><th>委托数</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.limitPrice.amount}><td>{formatMoney({ amount: row.limitPrice.amount, currency: "GAME_CREDIT" })}</td><td>{row.remainingQuantity}</td><td>{row.orderCount}</td></tr>)}</tbody>
  </table>;
}
