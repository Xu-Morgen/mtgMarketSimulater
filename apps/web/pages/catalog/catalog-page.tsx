"use client";

import type { CardFinish, CatalogSkuDto } from "@mtg-market/contracts";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { type CatalogFilters, useCatalogDetailQuery, useCatalogQuery } from "../../api/catalog-api";
import { ApiClientError } from "../../api/client";
import { EmptyState, ErrorState, FilterBar, PageSkeleton, Pagination } from "../../components/ui";

const finishes: Array<{ value: CardFinish; label: string }> = [{ value: "nonfoil", label: "非闪" }, { value: "foil", label: "闪" }, { value: "etched", label: "蚀刻" }];

function sourceLabel(sku: CatalogSkuDto): string { return sku.isManualException ? "运营测试例外" : sku.source === "scryfall" ? "本地 Scryfall 目录" : "人工目录"; }
function finishLabel(finish: CardFinish): string { return finishes.find((item) => item.value === finish)?.label ?? finish; }
function ImageFallback({ sku }: { sku: CatalogSkuDto }) {
  return sku.image.status === "cached" && sku.image.path ? <div className="catalog-image cached" role="img" aria-label={`${sku.name} 图片已缓存`}>本地图片已缓存</div> : <div className="catalog-image" role="img" aria-label={`${sku.name} 暂无图片`}>暂无图片</div>;
}
function filtersFromSearch(search: URLSearchParams | null): CatalogFilters {
  const value = search ?? new URLSearchParams();
  const finish = value.get("finish");
  return {
    query: value.get("query") || undefined, setCode: value.get("setCode") || undefined, rarity: value.get("rarity") || undefined,
    finish: finish === "nonfoil" || finish === "foil" || finish === "etched" ? finish : undefined, cursor: value.get("cursor") || undefined
  };
}
function toUrl(filters: CatalogFilters): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
  const suffix = search.toString();
  return suffix ? `/catalog?${suffix}` : "/catalog";
}

export function CatalogPage() {
  const router = useRouter(); const pathname = usePathname(); const search = useSearchParams();
  const filters = filtersFromSearch(search); const catalog = useCatalogQuery(filters);
  const [draft, setDraft] = useState({ query: filters.query ?? "", setCode: filters.setCode ?? "", rarity: filters.rarity ?? "", finish: filters.finish ?? "" });
  const apply = (next: Omit<CatalogFilters, "cursor">) => router.push(toUrl(next));
  if (catalog.isPending) return <PageSkeleton label="正在加载卡牌目录" />;
  if (catalog.isError) return <main className="page"><ErrorState title="卡牌目录加载失败" onRetry={() => void catalog.refetch()} /></main>;
  const page = catalog.data.data;
  return <main className="page catalog-page"><p className="eyebrow">本地卡牌目录</p><h1>浏览印刷版本</h1><p className="intro">每一行均为独立可识别的印刷 SKU；浏览只读取本地目录，不会访问外部卡牌或图片服务。</p>
    <form className="catalog-filters" onSubmit={(event) => { event.preventDefault(); apply({ query: draft.query.trim() || undefined, setCode: draft.setCode.trim().toUpperCase() || undefined, rarity: draft.rarity.trim() || undefined, finish: draft.finish as CardFinish || undefined }); }}>
      <FilterBar><label>名称<input aria-label="名称筛选" value={draft.query} onChange={(event) => setDraft({ ...draft, query: event.target.value })} /></label><label>系列<input aria-label="系列筛选" value={draft.setCode} onChange={(event) => setDraft({ ...draft, setCode: event.target.value })} placeholder="例如 ONE" /></label><label>稀有度<input aria-label="稀有度筛选" value={draft.rarity} onChange={(event) => setDraft({ ...draft, rarity: event.target.value })} placeholder="例如 mythic" /></label><label>工艺<select aria-label="工艺筛选" value={draft.finish} onChange={(event) => setDraft({ ...draft, finish: event.target.value })}><option value="">全部</option>{finishes.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></label><button className="button" type="submit">应用筛选</button><button className="button secondary" type="button" onClick={() => { setDraft({ query: "", setCode: "", rarity: "", finish: "" }); router.push(pathname ?? "/catalog"); }}>清除</button></FilterBar>
    </form>
    {page.items.length === 0 ? <EmptyState title="没有符合条件的卡牌 SKU">请调整名称、系列、稀有度或工艺筛选条件。</EmptyState> : <section className="catalog-grid" aria-label="卡牌目录结果">{page.items.map((sku) => <article className="catalog-card" key={sku.id}><ImageFallback sku={sku} /><div><p className="catalog-meta">{sku.setCode} · #{sku.collectorNumber} · {finishLabel(sku.finish)}</p><h2><Link href={`/catalog/${sku.id}`}>{sku.name}</Link></h2><p>{sku.setName} · {sku.rarity}</p><p className="catalog-source">来源：{sourceLabel(sku)}</p><p className={sku.tradable ? "tradable" : "not-tradable"}>{sku.tradable ? "可交易" : "不可交易"}</p></div></article>)}</section>}
    <Pagination page={Number.parseInt(filters.cursor ?? "0", 10) / 2 + 1} onPrevious={() => { const previous = Math.max(0, Number.parseInt(filters.cursor ?? "0", 10) - 2); router.push(toUrl({ ...filters, cursor: previous ? String(previous) : undefined })); }} onNext={() => router.push(toUrl({ ...filters, cursor: page.page.nextCursor ?? undefined }))} hasNext={page.page.hasMore} />
  </main>;
}

export function CatalogDetailPage({ skuId }: { skuId: string }) {
  const detail = useCatalogDetailQuery(skuId);
  if (detail.isPending) return <PageSkeleton label="正在加载卡牌详情" />;
  if (detail.isError) return <main className="page">{detail.error instanceof ApiClientError && detail.error.code === "RESOURCE_NOT_FOUND" ? <EmptyState title="卡牌 SKU 不存在">它可能已不在当前本地目录中。</EmptyState> : <ErrorState title="卡牌详情加载失败" onRetry={() => void detail.refetch()} />}</main>;
  const sku = detail.data.data.sku;
  return <main className="page catalog-detail"><Link href="/catalog" className="back-link">返回卡牌目录</Link><p className="eyebrow">{sku.setCode} · #{sku.collectorNumber} · {finishLabel(sku.finish)}</p><h1>{sku.name}</h1><section className="detail-grid"><ImageFallback sku={sku} /><div className="detail-card"><p><strong>系列：</strong>{sku.setName}</p><p><strong>稀有度：</strong>{sku.rarity}</p><p><strong>工艺：</strong>{finishLabel(sku.finish)}</p><p><strong>来源：</strong>{sourceLabel(sku)}</p><p><strong>交易状态：</strong>{sku.tradable ? "可交易" : "不可交易"}</p><p><strong>图片：</strong>{sku.image.status === "cached" ? "本地缓存" : "暂无本地图片，已使用文字降级展示"}</p></div></section><section className="detail-card"><h2>规则与印刷信息</h2><p><strong>发布日期：</strong>{sku.releasedAt ?? "未提供"}</p><p><strong>画师：</strong>{sku.artist ?? "未提供"}</p><p><strong>规则文本：</strong>{sku.oracleText ?? "未提供"}</p><h2>赛制合法性</h2><ul>{Object.entries(sku.legalities).map(([format, legality]) => <li key={format}>{format}：{legality}</li>)}</ul></section></main>;
}
