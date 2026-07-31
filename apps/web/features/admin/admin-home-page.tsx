"use client";

import type { AdminAuditLogDto, AdminDashboardDto, AdminExceptionTradeDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useAdminDashboardQuery, useAdminExceptionTradesQuery } from "../../api/admin-api";
import { ApiClientError } from "../../api/client";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { formatDateTime } from "./admin-format";
import styles from "./admin-shared.module.css";

const environmentLabel: Record<AdminDashboardDto["environment"], string> = {
  development: "开发", test: "测试", production: "生产"
};

/** I30F 后台首页：聚合只读管理 API 的环境、新鲜度、失败任务、活动、待复核异常与最近操作摘要。 */
export function AdminHomePage() {
  const dashboard = useAdminDashboardQuery();
  const exceptions = useAdminExceptionTradesQuery(10);
  if (dashboard.isPending) return <PageSkeleton label="正在加载运营总览" />;
  if (dashboard.isError) return <main className="page"><ErrorState title={dashboard.error instanceof ApiClientError && dashboard.error.code === "AUTHORIZATION_DENIED" ? "无权查看运营总览" : "运营总览加载失败"} onRetry={() => void dashboard.refetch()} /></main>;
  if (!dashboard.data) return <PageSkeleton label="正在确认运营总览访问权限" />;
  const data = dashboard.data.data;
  const reviewItems = exceptions.data?.data.items ?? [];
  return <main className={`page ${styles.page}`}>
    <p className="eyebrow">管理后台</p>
    <h1>运营总览</h1>
    <p className={styles.intro}>所有摘要均来自只读管理 API；写操作、敏感字段和未脱敏原文不会出现在此页。环境标识 <strong>{environmentLabel[data.environment]}</strong>。</p>
    <section className={styles.statGrid} aria-label="关键指标">
      <div className={styles.stat}><span>目录新鲜度</span><strong className={`${styles.freshness} ${styles[data.catalogFreshness.status]}`}>{freshness(data.catalogFreshness.status)}</strong><span>{formatDateTime(data.catalogFreshness.updatedAt)}</span></div>
      <div className={styles.stat}><span>价格新鲜度</span><strong className={`${styles.freshness} ${styles[data.priceFreshness.status]}`}>{freshness(data.priceFreshness.status)}</strong><span>{formatDateTime(data.priceFreshness.updatedAt)}</span></div>
      <div className={styles.stat}><span>失败任务</span><strong>{data.failedJobCount}</strong><Link href="/admin/jobs">查看任务与异常</Link></div>
      <div className={styles.stat}><span>进行中活动</span><strong>{data.activeCampaignCount}</strong><Link href="/admin/events">管理活动</Link></div>
    </section>
    <section className={styles.card}>
      <h2>待复核异常</h2>
      <p className={styles.intro}>聚合待复核风控标记与失败任务；此页只读，不会改写订单、库存或任务状态。</p>
      {reviewItems.length === 0 ? <EmptyState title="没有待复核异常">当前没有服务端标记的待复核项。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>时间</th><th>类型</th><th>状态</th><th>原因</th><th>实体</th></tr></thead><tbody>
        {reviewItems.map((item) => <ExceptionRow key={`${item.kind}-${item.id}`} item={item} />)}
      </tbody></table></div>}
      <div className={styles.actions}><Link className="button secondary" href="/admin/jobs">查看全部任务与异常</Link></div>
    </section>
    <section className={styles.card}>
      <h2>最近管理操作</h2>
      <p className={styles.intro}>最近 10 条不可变审计摘要；详细关联记录见日志页。</p>
      {data.recentActions.length === 0 ? <EmptyState title="暂无最近操作">后台操作发生后会在此显示脱敏摘要。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>时间</th><th>动作</th><th>实体</th><th>请求 ID</th></tr></thead><tbody>
        {data.recentActions.map((log) => <RecentActionRow key={log.id} log={log} />)}
      </tbody></table></div>}
      <div className={styles.actions}><Link className="button secondary" href="/admin/logs">查看完整日志</Link></div>
    </section>
  </main>;
}

function freshness(status: "fresh" | "stale" | "unavailable"): string {
  return ({ fresh: "新鲜", stale: "过期", unavailable: "不可用" })[status];
}

function ExceptionRow({ item }: { item: AdminExceptionTradeDto }) {
  return <tr>
    <td>{formatDateTime(item.occurredAt)}</td>
    <td>{item.kind === "risk_flagged" ? "待复核风控" : "失败任务"}</td>
    <td><span className={item.kind === "failed_job" ? styles.failed : styles.flagged}>{item.status}</span></td>
    <td className={styles.mono}>{item.reason || "—"}</td>
    <td className={styles.mono}>{item.entityType} · {item.entityId}</td>
  </tr>;
}

function RecentActionRow({ log }: { log: AdminAuditLogDto }) {
  return <tr>
    <td>{formatDateTime(log.occurredAt)}</td>
    <td>{log.action}</td>
    <td className={styles.mono}>{log.entityType} · {log.entityId}</td>
    <td className={styles.mono}>{log.requestId ?? "—"}</td>
  </tr>;
}
