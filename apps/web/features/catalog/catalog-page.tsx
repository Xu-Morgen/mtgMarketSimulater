"use client";

import { Button, Pagination as AntPagination, Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { CardFinish, CatalogSkuDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { type CatalogFilters, useCatalogQuery } from "../../api/catalog-api";
import { usePublicPriceStatusQuery } from "../../api/pricing-api";
import { CatalogCardDetailModal } from "../../components/catalog-card-detail-modal";
import { PriceStatus } from "../../components/price-status";
import { EmptyState, ErrorState, FilterBar, PageSkeleton } from "../../components/ui";
import styles from "./catalog-table.module.css";

const defaultPageSize = 20;
const pageSizeOptions = [20, 50, 100];
const finishes: Array<{ value: CardFinish; label: string }> = [{ value: "nonfoil", label: "非闪" }, { value: "foil", label: "闪" }, { value: "etched", label: "蚀刻" }];

function sourceLabel(sku: CatalogSkuDto): string { return sku.isManualException ? "运营测试例外" : sku.source === "scryfall" ? "本地 Scryfall 目录" : "人工目录"; }
function finishLabel(finish: CardFinish): string { return finishes.find((item) => item.value === finish)?.label ?? finish; }
function filtersFromSearch(search: URLSearchParams | null): CatalogFilters {
  const value = search ?? new URLSearchParams(); const finish = value.get("finish");
  const requestedLimit = Number.parseInt(value.get("limit") ?? "", 10); const limit = pageSizeOptions.includes(requestedLimit) ? requestedLimit : defaultPageSize;
  return { query: value.get("query") || undefined, setCode: value.get("setCode") || undefined, rarity: value.get("rarity") || undefined, finish: finish === "nonfoil" || finish === "foil" || finish === "etched" ? finish : undefined, cursor: value.get("cursor") || undefined, limit };
}
function toUrl(filters: CatalogFilters): string { const search = new URLSearchParams(); for (const [key, value] of Object.entries(filters)) if (value && (key !== "limit" || value !== defaultPageSize)) search.set(key, String(value)); const suffix = search.toString(); return suffix ? `/catalog?${suffix}` : "/catalog"; }
function skuHistoryHref(skuId: string): string { return `/market/history?skuId=${encodeURIComponent(skuId)}`; }

export function CatalogPage() {
  const router = useRouter(); const search = useSearchParams(); const filters = filtersFromSearch(search); const catalog = useCatalogQuery(filters); const priceStatus = usePublicPriceStatusQuery();
  const [selectedSkuId, setSelectedSkuId] = useState<string | null>(null); const [draft, setDraft] = useState({ query: filters.query ?? "", setCode: filters.setCode ?? "", rarity: filters.rarity ?? "", finish: filters.finish ?? "" });
  const apply = (next: Omit<CatalogFilters, "cursor">) => router.push(toUrl(next));
  const pageSize = filters.limit ?? defaultPageSize;
  const currentPage = Math.floor(Number.parseInt(filters.cursor ?? "0", 10) / pageSize) + 1;
  const columns = useMemo<ColumnsType<CatalogSkuDto>>(() => [
    { title: "名称", dataIndex: "name", key: "name", render: (name: string, sku) => <strong><span className="rarity-dot" data-rarity={sku.rarity?.toLowerCase()} aria-hidden="true" /><Link className="text-button" href={skuHistoryHref(sku.id)}>{name}</Link></strong> },
    { title: "系列 / 编号", key: "printing", render: (_, sku) => `${sku.setCode} · #${sku.collectorNumber}` },
    { title: "工艺", dataIndex: "finish", key: "finish", render: (finish: CardFinish) => finishLabel(finish) },
    { title: "稀有度", dataIndex: "rarity", key: "rarity" },
    { title: "来源", key: "source", render: (_, sku) => sourceLabel(sku) },
    { title: "价格与交易状态", key: "tradable", render: (_, sku) => <PriceStatus status={priceStatus.isError ? null : priceStatus.data?.data} tradable={sku.tradable} /> },
    { title: "操作", key: "actions", render: (_, sku) => <Button type="link" onClick={() => setSelectedSkuId(sku.id)}>详情</Button> }
  ], [priceStatus.data?.data, priceStatus.isError]);
  if (catalog.isPending) return <PageSkeleton label="正在加载卡牌目录" />;
  if (catalog.isError) return <main className="page"><ErrorState title="卡牌目录加载失败" onRetry={() => void catalog.refetch()} /></main>;
  const page = catalog.data.data; const total = page.page.total ?? (currentPage - 1) * pageSize + page.items.length + (page.page.hasMore ? 1 : 0);
  return <main className="page catalog-page"><p className="eyebrow">本地卡牌目录</p><h1>浏览印刷版本</h1><p className="intro">每一行均为独立可识别的印刷 SKU；目录与图片均只读取本地服务端数据。</p>
    <form className="catalog-filters" onSubmit={(event) => { event.preventDefault(); apply({ query: draft.query.trim() || undefined, setCode: draft.setCode.trim().toUpperCase() || undefined, rarity: draft.rarity.trim() || undefined, finish: draft.finish as CardFinish || undefined, limit: pageSize }); }}><FilterBar><label>名称<input aria-label="名称筛选" value={draft.query} onChange={(event) => setDraft({ ...draft, query: event.target.value })} /></label><label>系列<input aria-label="系列筛选" value={draft.setCode} onChange={(event) => setDraft({ ...draft, setCode: event.target.value })} placeholder="例如 ONE" /></label><label>稀有度<input aria-label="稀有度筛选" value={draft.rarity} onChange={(event) => setDraft({ ...draft, rarity: event.target.value })} placeholder="例如 mythic" /></label><label>工艺<select aria-label="工艺筛选" value={draft.finish} onChange={(event) => setDraft({ ...draft, finish: event.target.value })}><option value="">全部</option>{finishes.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><button className="button" type="submit">应用筛选</button><button className="button secondary" type="button" onClick={() => { setDraft({ query: "", setCode: "", rarity: "", finish: "" }); router.push(toUrl({ limit: pageSize })); }}>清除</button></FilterBar></form>
    {page.items.length === 0 ? <EmptyState title="没有符合条件的卡牌 SKU">请调整名称、系列、稀有度或工艺筛选条件。</EmptyState> : <><div className={styles.tableWrap}><Table columns={columns} dataSource={page.items} rowKey="id" pagination={false} scroll={{ x: 820 }} /></div><div className={styles.pagination}><AntPagination current={currentPage} pageSize={pageSize} total={total} showSizeChanger showQuickJumper pageSizeOptions={pageSizeOptions} showTotal={(count, range) => `第 ${range[0]}–${range[1]} 张，共 ${count} 张（${Math.ceil(count / pageSize)} 页）`} onChange={(nextPage, nextPageSize) => { const nextLimit = Number(nextPageSize); const pageChangedBySize = nextLimit !== pageSize; router.push(toUrl({ ...filters, limit: nextLimit, cursor: pageChangedBySize || nextPage === 1 ? undefined : String((nextPage - 1) * nextLimit) })); }} /></div></>}
    <CatalogCardDetailModal skuId={selectedSkuId} onClose={() => setSelectedSkuId(null)} />
  </main>;
}

export function CatalogDetailPage({ skuId }: { skuId: string }) { return <main className="page"><CatalogCardDetailModal skuId={skuId} onClose={() => window.history.back()} /></main>; }
