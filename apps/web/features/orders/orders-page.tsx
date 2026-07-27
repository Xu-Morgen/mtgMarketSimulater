"use client";

import { Pagination as AntPagination, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { BilateralOrderDto, OrderSide, OrderStatus } from "@mtg-market/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { type OrdersFilters, useCancelOrderMutation, useOrdersQuery } from "../../api/orders-api";
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
function toUrl(filters: OrdersFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value && !(key === "limit" && value === defaultPageSize)) search.set(key, String(value));
  const suffix = search.toString();
  return suffix ? `/orders?${suffix}` : "/orders";
}
function isCancellable(order: BilateralOrderDto): boolean {
  return order.status === "open" || order.status === "partially_filled";
}

/** 我的委托只展示服务端订单状态与字段；撤单以幂等键提交，资源冲突要求刷新后重试。 */
export function OrdersPage() {
  const router = useRouter();
  const search = useSearchParams();
  const filters = filtersFromSearch(search);
  const orders = useOrdersQuery(filters);
  const cancel = useCancelOrderMutation();
  const [pendingCancel, setPendingCancel] = useState<BilateralOrderDto | null>(null);
  const [cancelledOrder, setCancelledOrder] = useState<BilateralOrderDto | null>(null);
  const [cancelConflict, setCancelConflict] = useState<string | null>(null);
  const pageSize = filters.limit ?? defaultPageSize;
  const currentPage = Math.floor(Number.parseInt(filters.cursor ?? "0", 10) / pageSize) + 1;

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
  const apply = (next: Partial<Pick<OrdersFilters, "status" | "side">>) => router.push(toUrl({ ...filters, ...next, cursor: undefined }));

  return <main className="page orders-page">
    <p className="eyebrow">服务端订单状态投影</p>
    <h1>我的委托</h1>
    <p className="intro">委托、限价、费用、保证金、预占资金与状态均来自服务端。此页面只展示订单状态与撤单入口；撮合、模拟履约与到期回收将在后续迭代上线。</p>
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
      <div className={styles.pagination}><AntPagination current={currentPage} pageSize={pageSize} total={total} showSizeChanger showQuickJumper pageSizeOptions={pageSizeOptions} showTotal={(count, range) => `第 ${range[0]}–${range[1]} 项，共 ${count} 项`} onChange={(nextPage, nextPageSize) => { const nextLimit = Number(nextPageSize); const changedSize = nextLimit !== pageSize; router.push(toUrl({ ...filters, limit: nextLimit, cursor: changedSize || nextPage === 1 ? undefined : String((nextPage - 1) * nextLimit) })); }} /></div>
    </>}
    <ConfirmDialog open={pendingCancel !== null} title="确认撤单" description={pendingCancel ? `将撤销该${pendingCancel.side === "buy" ? "买单" : "卖单"}并释放预占资金${pendingCancel.side === "buy" ? ` ${formatMoney(pendingCancel.reservedFunds ?? { amount: 0, currency: "GAME_CREDIT" })}` : pendingCancel.reservedInventoryQuantity > 0 ? `、解锁库存 ${pendingCancel.reservedInventoryQuantity} 张` : ""}；已成交部分不会被释放。是否继续？` : ""} onCancel={() => setPendingCancel(null)} onConfirm={confirmCancel} />
  </main>;
}
