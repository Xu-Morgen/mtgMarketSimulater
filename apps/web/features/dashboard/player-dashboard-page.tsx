"use client";

import type { DailyWorkFundingStatusDto, LedgerEntryDto, PlayerDashboardDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { useArchiveQuery, useCreateArchiveMutation, useLedgerQuery } from "../../api/archive-api";
import { useDashboardQuery } from "../../api/dashboard-api";
import { useClaimDailyWorkFundingMutation } from "../../api/daily-work-funding-api";
import { useGrowthQuery } from "../../api/growth-api";
import { EmptyState, ErrorState, PageSkeleton, Pagination } from "../../components/ui";
import { GrowthCard } from "../growth/growth-card";
import { OnboardingEntryCard } from "../onboarding/onboarding-entry-card";
import { formatMoney } from "../../utils/money";

function serverTime(value: string, timezone: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "long", timeStyle: "short", timeZone: timezone }).format(new Date(value));
}

function LedgerTable({ entries }: { entries: LedgerEntryDto[] }) {
  if (entries.length === 0) return <EmptyState title="暂无账本流水">后续资金变动会由服务器记录在这里。</EmptyState>;
  return <div className="ledger-table" role="region" aria-label="账本流水" tabIndex={0}>
    <table>
      <thead><tr><th>时间</th><th>类型</th><th>金额</th><th>变更后余额</th></tr></thead>
      <tbody>{entries.map((entry) => <tr key={entry.id}><td>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(entry.occurredAt))}</td><td>{entry.reason === "initial_funding" ? "初始资金" : entry.reason === "daily_work_funding" ? "每日工作资金" : entry.reason}</td><td className={entry.direction === "credit" ? "credit" : "debit"}>{entry.direction === "credit" ? "+" : "-"}{formatMoney(entry.amount)}</td><td>{formatMoney(entry.balanceAfter)}</td></tr>)}</tbody>
    </table>
  </div>;
}

function DailyWorkFundingCard({ status }: { status: DailyWorkFundingStatusDto }) {
  const claim = useClaimDailyWorkFundingMutation();
  const canClaim = status.status === "available" && status.amount !== null;
  const statusLabel = status.status === "available" ? "今日可领取" : status.status === "claimed" ? "今日已领取" : status.status === "not_open" ? "等待服务器开放" : "需要先创建存档";
  // I36F：锚点放在卡片区而非领取按钮上——无论「可领取/已领取/未开放」卡片都会渲染，
  // 引导 Tour 在创建存档切换首页分支后总能定位并滚动到本卡片；领取按钮在卡片内（蒙层不拦截点击）。
  return <section id="onboarding-work-funds" className="dashboard-section daily-work-funding panel" aria-labelledby="daily-work-funding-title">
    <h2 className="panel-title" id="daily-work-funding-title">每日工作资金</h2>
    <article className="daily-work-funding-card">
      <p className="daily-work-funding-status" role="status">{statusLabel}</p>
      <p>服务端日期：<strong>{status.naturalDate}</strong>（{status.timezone}）</p>
      {status.amount ? <p>本日金额：<strong className="num">{formatMoney(status.amount)}</strong></p> : <p>本日金额将在服务器开放资格后显示。</p>}
      {status.ruleVersion ? <p className="daily-work-funding-meta">规则版本：{status.ruleVersion}</p> : null}
      {status.openedAt ? <p className="daily-work-funding-meta">服务器开放时间：{serverTime(status.openedAt, status.timezone)}</p> : null}
      {status.claim ? <p>领取记录：{formatMoney(status.claim.amount)}，{serverTime(status.claim.claimedAt, status.timezone)} 已由服务器记入账本。</p> : null}
      <p>下一次可领取：<strong>{serverTime(status.nextEligibleAt, status.timezone)}</strong></p>
      {canClaim ? <div className="actions"><button className="button" type="button" disabled={claim.isPending} onClick={claim.claim}>{claim.isPending ? "正在向服务器领取…" : `领取 ${formatMoney(status.amount!)}`}</button></div> : status.status === "claimed" ? <div className="actions"><button className="button" type="button" disabled>今日已领取</button></div> : null}
      {claim.isSuccess ? <p className="daily-work-funding-success" role="status">领取请求已由服务器完成，余额、资格和账本流水已刷新。</p> : null}
      {claim.isError ? <p className="form-error" role="alert">{claim.error instanceof Error ? claim.error.message : "领取失败；正在重新查询服务器状态。"}</p> : null}
    </article>
  </section>;
}

function OverviewCards({ overview }: { overview: PlayerDashboardDto }) {
  const index = overview.marketIndex;
  return <>
    <section className="balance-grid notice-board" aria-label="账户余额与服务端净资产">
      <article><span>总额</span><strong className="num">{formatMoney(overview.balance.total)}</strong></article>
      <article><span>可用额</span><strong className="num">{formatMoney(overview.balance.available)}</strong></article>
      <article><span>冻结额</span><strong className="num">{formatMoney(overview.balance.frozen)}</strong></article>
      <article><span>净资产</span><strong className="num">{overview.netWorth ? formatMoney(overview.netWorth) : "存在未报价持仓，暂不可用"}</strong><small>服务端仅在全部持仓有有效报价时返回</small></article>
    </section>
    <section className="dashboard-section" aria-labelledby="dashboard-today-title">
      <h2 id="dashboard-today-title">今日循环</h2>
      <div className="balance-grid notice-board" aria-label="今日比赛、收藏与市场指数">
        <article><span>今日比赛</span><strong className="num">{overview.todayTournaments.registeredCount} 场已报名</strong><small>可报名 {overview.todayTournaments.availableCount} · 结算中 {overview.todayTournaments.settlingCount} · 已结算 {overview.todayTournaments.settledCount}</small></article>
        <article><span>收藏册基础进度</span><strong className="num">{overview.collection.distinctSkuCount} 种 / {overview.collection.totalCardCount} 张</strong><small>{overview.collection.unpricedSkuCount > 0 ? `${overview.collection.unpricedSkuCount} 种持仓暂无有效报价` : `服务端市值 ${formatMoney(overview.collection.marketValue!)}`}</small></article>
        <article><span>市场指数</span><strong className="num">{index.gameIndex === null ? "暂无游戏内指数" : index.gameIndex.toLocaleString("zh-CN")}</strong><small>{index.referenceIndex === null ? "暂无外部参考指数" : `外部参考 ${index.referenceIndex.toLocaleString("zh-CN")} EUR 分`} · 已报价 {index.quotedSkus} 个 SKU</small></article>
      </div>
      <div className="actions"><Link className="button secondary" href="/tasks">查看任务中心</Link><Link className="button secondary" href="/collection">查看收藏册</Link><Link className="button secondary" href="/tournaments">查看今日比赛</Link><Link className="button secondary" href="/market">查看市场</Link></div>
    </section>
    <section className="dashboard-section" aria-labelledby="dashboard-todo-title">
      <h2 id="dashboard-todo-title">服务端待办</h2>
      {overview.todos.length === 0 ? <EmptyState title="当前没有待办">继续浏览市场、收藏与历史赛事，所有资产状态会以服务器下一次快照为准。</EmptyState> : <ul className="todo-list">{overview.todos.map((todo) => <li key={todo.id}><Link className="text-button" href={todo.href}>{todo.label} →</Link></li>)}</ul>}
    </section>
  </>;
}

export function PlayerDashboardPage() {
  const archive = useArchiveQuery();
  const dashboard = useDashboardQuery();
  const growth = useGrowthQuery();
  const createArchive = useCreateArchiveMutation();
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1) ?? null;
  const hasArchive = archive.isSuccess;
  const ledger = useLedgerQuery(cursor, hasArchive);

  if (archive.isPending) return <PageSkeleton label="正在加载玩家存档" />;
  if (archive.isError && !(archive.error instanceof ApiClientError && archive.error.code === "RESOURCE_NOT_FOUND")) return <main className="page"><ErrorState title="存档加载失败" onRetry={() => void archive.refetch()} /></main>;
  if (!hasArchive) return <main className="page"><p className="eyebrow">玩家首页</p><h1>开始你的市场之旅</h1><EmptyState title="尚未创建游戏存档">创建后，服务器会初始化你的账户和初始资金。</EmptyState><div className="actions"><button id="onboarding-create-archive" className="button" type="button" onClick={() => createArchive.mutate()} disabled={createArchive.isPending}>{createArchive.isPending ? "正在创建存档…" : "创建游戏存档"}</button></div>{createArchive.isError ? <p className="form-error" role="alert">{createArchive.error instanceof Error ? createArchive.error.message : "创建存档失败，请重试。"}</p> : null}
    {/* I36F：未创建存档的新玩家也展示常驻新手引导入口（引导只读查询对未存档玩家开放，可直接进入 /onboarding 了解首次目标链）。 */}
    <section className="dashboard-section" aria-labelledby="dashboard-onboarding-title"><OnboardingEntryCard /></section>
  </main>;

  const ledgerData = ledger.data?.data;
  const growthProfile = growth.data?.data;
  return <main className="page dashboard-page"><p className="eyebrow">玩家首页</p><h1>账户概览</h1><p className="intro">余额、净资产、今日比赛、市场指数、收藏统计和待办都由服务器聚合；页面不会自行结算或改写资产。</p>
    {dashboard.isPending ? <PageSkeleton label="正在读取服务端首页概览" /> : dashboard.isError ? <ErrorState title="首页概览加载失败" onRetry={() => void dashboard.refetch()} /> : dashboard.data ? <><OverviewCards overview={dashboard.data.data.overview} /><DailyWorkFundingCard status={dashboard.data.data.overview.dailyWorkFunding} /></> : null}
    <section className="dashboard-section" aria-labelledby="dashboard-onboarding-title"><OnboardingEntryCard /></section>
    <section className="dashboard-section" aria-labelledby="dashboard-growth-title"><h2 id="dashboard-growth-title">等级与声望</h2>{growth.isPending ? <PageSkeleton label="正在加载等级档案" /> : growth.isError ? <ErrorState title="等级档案加载失败" onRetry={() => void growth.refetch()} /> : growthProfile ? <GrowthCard profile={growthProfile} /> : null}</section>
    <section className="dashboard-section"><h2>账本流水</h2>{ledger.isPending ? <PageSkeleton label="正在加载账本流水" /> : ledger.isError ? <ErrorState title="账本加载失败" onRetry={() => void ledger.refetch()} /> : <><LedgerTable entries={ledgerData?.items ?? []} /><Pagination page={cursors.length + 1} onPrevious={() => setCursors((items) => items.slice(0, -1))} onNext={() => { if (ledgerData?.page.nextCursor) setCursors((items) => [...items, ledgerData.page.nextCursor!]); }} hasNext={ledgerData?.page.hasMore ?? false} /></>}</section>
    <section className="dashboard-section"><h2>继续循环</h2><p className="intro">完成服务端待办后，可继续通过补充包、市场、委托、卡组和比赛入口进行下一次投资。</p></section>
  </main>;
}
