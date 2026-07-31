"use client";

import Link from "next/link";
import { useDashboardQuery } from "../../api/dashboard-api";
import { useInventoryQuery } from "../../api/inventory-api";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";

/** 收藏册只展示服务端聚合进度与库存快照；不在浏览器统计数量、估值或解锁收藏成就。 */
export function CollectionPage() {
  const dashboard = useDashboardQuery();
  const inventory = useInventoryQuery({ locked: "any", sort: "name", direction: "asc", limit: 100 });
  if (dashboard.isPending || inventory.isPending) return <PageSkeleton label="正在加载服务端收藏册" />;
  if (dashboard.isError || inventory.isError) return <main className="page"><ErrorState title="收藏册加载失败" onRetry={() => { void dashboard.refetch(); void inventory.refetch(); }} /></main>;
  const overview = dashboard.data?.data.overview;
  const holdings = inventory.data?.data.items ?? [];
  if (!overview) return <main className="page"><EmptyState title="尚无收藏数据">请先创建游戏存档。</EmptyState></main>;
  return <main className="page collection-page"><p className="eyebrow">服务端收藏快照</p><h1>收藏册</h1><p className="intro">进度、市值和未报价提示均由服务端聚合。选择卡牌可查看本地目录详情；库存和比赛跳转不会修改任何持仓或报名。</p>
    <section className="balance-grid" aria-label="收藏册进度">
      <article><span>已收集 SKU</span><strong>{overview.collection.distinctSkuCount} 种</strong><small>当前持有 {overview.collection.totalCardCount} 张</small></article>
      <article><span>收藏市值</span><strong>{overview.collection.marketValue ? formatMoney(overview.collection.marketValue) : "暂不可用"}</strong><small>{overview.collection.unpricedSkuCount > 0 ? `${overview.collection.unpricedSkuCount} 种持仓没有有效报价` : "全部持仓已有服务端报价"}</small></article>
      <article><span>赛事与库存</span><strong>{overview.todayTournaments.registeredCount} 场今日已报名</strong><small>比赛锁定量请在库存页查看</small></article>
    </section>
    <div className="actions"><Link className="button secondary" href="/inventory">查看完整库存与锁定</Link><Link className="button secondary" href="/tournaments">前往今日比赛</Link><Link className="button secondary" href="/catalog">浏览本地目录</Link></div>
    <section className="dashboard-section" aria-labelledby="collection-cards-title"><h2 id="collection-cards-title">已持有卡牌</h2>{holdings.length === 0 ? <EmptyState title="收藏册暂为空">通过补充包、NPC 交易、P2P 模拟履约或赛事奖励获得卡牌后，服务器会更新这里。</EmptyState> : <ul className="collection-list">{holdings.map((holding) => <li key={holding.skuId}><div><strong>{holding.sku.name}</strong><span>{holding.sku.setCode} · #{holding.sku.collectorNumber} · {holding.sku.finish} · 持有 {holding.quantity} 张</span></div><Link className="text-button" href={`/catalog/${holding.skuId}`}>查看卡牌详情</Link></li>)}</ul>}{inventory.data?.data.page.hasMore ? <p className="muted">当前仅展示前 100 个服务端库存条目；请前往完整库存继续浏览和筛选。</p> : null}</section>
  </main>;
}
