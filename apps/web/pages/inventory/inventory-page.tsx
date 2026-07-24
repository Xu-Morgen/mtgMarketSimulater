"use client";

import { Button, Pagination as AntPagination, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { CardFinish, InventoryHoldingDto } from "@mtg-market/contracts";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { type InventoryFilters, useInventoryQuery } from "../../api/inventory-api";
import { EmptyState, ErrorState, FilterBar, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import styles from "./inventory-page.module.css";

const defaultPageSize = 20;
const pageSizeOptions = [20, 50, 100];
const finishes: Array<{ value: CardFinish; label: string }> = [{ value: "nonfoil", label: "非闪" }, { value: "foil", label: "闪" }, { value: "etched", label: "蚀刻" }];

function finishLabel(finish: CardFinish): string { return finishes.find((item) => item.value === finish)?.label ?? finish; }
function unavailableReason(reason: InventoryHoldingDto["marketValueUnavailableReason"]): string {
  return reason === "stale_snapshot" ? "价格快照已过期，暂不显示市值。" : "尚无有效价格快照，暂不显示市值。";
}
function filtersFromSearch(search: URLSearchParams | null): InventoryFilters {
  const value = search ?? new URLSearchParams(); const finish = value.get("finish"); const requestedLimit = Number.parseInt(value.get("limit") ?? "", 10);
  const locked = value.get("locked"); const sort = value.get("sort"); const direction = value.get("direction");
  return {
    query: value.get("query") || undefined, setCode: value.get("setCode") || undefined,
    finish: finish === "nonfoil" || finish === "foil" || finish === "etched" ? finish : undefined,
    locked: locked === "locked" || locked === "available" ? locked : "any",
    sort: sort === "name" || sort === "quantity" || sort === "availableQuantity" ? sort : "updatedAt",
    direction: direction === "asc" ? "asc" : "desc", cursor: value.get("cursor") || undefined,
    limit: pageSizeOptions.includes(requestedLimit) ? requestedLimit : defaultPageSize
  };
}
function toUrl(filters: InventoryFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value && !(key === "limit" && value === defaultPageSize) && !(key === "locked" && value === "any") && !(key === "sort" && value === "updatedAt") && !(key === "direction" && value === "desc")) search.set(key, String(value));
  const suffix = search.toString(); return suffix ? `/inventory?${suffix}` : "/inventory";
}

/** 资产锁定只能由订单和比赛流程改变；此页仅解释服务端当前快照。 */
export function InventoryPage() {
  const router = useRouter(); const search = useSearchParams(); const filters = filtersFromSearch(search); const inventory = useInventoryQuery(filters);
  const [draft, setDraft] = useState<{ query: string; setCode: string; finish: CardFinish | ""; locked: "any" | "locked" | "available" }>({ query: filters.query ?? "", setCode: filters.setCode ?? "", finish: filters.finish ?? "", locked: filters.locked ?? "any" });
  const pageSize = filters.limit ?? defaultPageSize; const currentPage = Math.floor(Number.parseInt(filters.cursor ?? "0", 10) / pageSize) + 1;
  const columns = useMemo<ColumnsType<InventoryHoldingDto>>(() => [
    { title: "SKU / 印刷", key: "sku", render: (_, holding) => <div><strong>{holding.sku.name}</strong><br /><span className={styles.secondary}>{holding.sku.setCode} · #{holding.sku.collectorNumber} · {finishLabel(holding.sku.finish)}</span></div> },
    { title: "持有", dataIndex: "quantity", key: "quantity" }, { title: "可用", dataIndex: "availableQuantity", key: "available" },
    { title: "订单锁定", dataIndex: "orderLockedQuantity", key: "orderLocked" }, { title: "比赛锁定", dataIndex: "tournamentLockedQuantity", key: "tournamentLocked" },
    { title: "平均成本", key: "averageCost", render: (_, holding) => formatMoney(holding.averageCost) },
    { title: "市值 / 价格状态", key: "marketValue", render: (_, holding) => holding.marketValue ? <div><strong>{formatMoney(holding.marketValue)}</strong><br /><span className={styles.secondary}>服务端快照</span></div> : <Tag color="default">{unavailableReason(holding.marketValueUnavailableReason)}</Tag> },
    { title: "锁定状态", key: "locked", render: (_, holding) => holding.orderLockedQuantity + holding.tournamentLockedQuantity > 0 ? <Tag color="gold">已锁定</Tag> : <Tag color="green">全部可用</Tag> }
  ], []);
  if (inventory.isPending) return <PageSkeleton label="正在加载库存" />;
  if (inventory.isError) return <main className="page"><ErrorState title="库存加载失败" onRetry={() => void inventory.refetch()} /></main>;
  const page = inventory.data.data; const total = page.page.total ?? (currentPage - 1) * pageSize + page.items.length + (page.page.hasMore ? 1 : 0);
  const apply = () => router.push(toUrl({ query: draft.query.trim() || undefined, setCode: draft.setCode.trim().toUpperCase() || undefined, finish: draft.finish || undefined, locked: draft.locked, sort: filters.sort, direction: filters.direction, limit: pageSize }));
  return <main className="page inventory-page"><p className="eyebrow">服务端库存快照</p><h1>我的库存</h1><p className="intro">数量、成本、市值与锁定状态均来自服务端。此页面不提供修改库存或解锁资产的入口。</p>
    <form className="catalog-filters" onSubmit={(event) => { event.preventDefault(); apply(); }}><FilterBar>
      <label>名称<input aria-label="库存名称筛选" value={draft.query} onChange={(event) => setDraft({ ...draft, query: event.target.value })} /></label>
      <label>系列<input aria-label="库存系列筛选" value={draft.setCode} onChange={(event) => setDraft({ ...draft, setCode: event.target.value })} placeholder="例如 ONE" /></label>
      <label>工艺<select aria-label="库存工艺筛选" value={draft.finish} onChange={(event) => setDraft({ ...draft, finish: event.target.value as CardFinish | "" })}><option value="">全部</option>{finishes.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label>
      <label>可用状态<select aria-label="库存锁定筛选" value={draft.locked} onChange={(event) => setDraft({ ...draft, locked: event.target.value as "any" | "locked" | "available" })}><option value="any">全部</option><option value="available">有可用量</option><option value="locked">存在锁定</option></select></label>
      <label>排序<select aria-label="库存排序" value={`${filters.sort}:${filters.direction}`} onChange={(event) => { const [sort, direction] = event.target.value.split(":") as [InventoryFilters["sort"], InventoryFilters["direction"]]; router.push(toUrl({ ...filters, sort, direction, cursor: undefined })); }}><option value="updatedAt:desc">最近更新</option><option value="name:asc">名称（升序）</option><option value="quantity:desc">持有数量（降序）</option><option value="availableQuantity:desc">可用数量（降序）</option></select></label>
      <button className="button" type="submit">应用筛选</button><button className="button secondary" type="button" onClick={() => { setDraft({ query: "", setCode: "", finish: "", locked: "any" }); router.push("/inventory"); }}>清除</button><Button onClick={() => void inventory.refetch()}>刷新</Button>
    </FilterBar></form>
    {page.items.length === 0 ? <EmptyState title="库存为空">尚未持有符合当前条件的卡牌。获得卡牌后会由服务端更新库存。</EmptyState> : <><div className={styles.tableWrap}><Table columns={columns} dataSource={page.items} rowKey="skuId" pagination={false} scroll={{ x: 1100 }} /></div><div className={styles.pagination}><AntPagination current={currentPage} pageSize={pageSize} total={total} showSizeChanger showQuickJumper pageSizeOptions={pageSizeOptions} showTotal={(count, range) => `第 ${range[0]}–${range[1]} 项，共 ${count} 项`} onChange={(nextPage, nextPageSize) => { const nextLimit = Number(nextPageSize); const changedSize = nextLimit !== pageSize; router.push(toUrl({ ...filters, limit: nextLimit, cursor: changedSize || nextPage === 1 ? undefined : String((nextPage - 1) * nextLimit) })); }} /></div></>}
  </main>;
}
