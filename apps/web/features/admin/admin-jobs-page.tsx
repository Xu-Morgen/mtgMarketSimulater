"use client";

import Link from "next/link";
import { useState } from "react";
import { useAdminExceptionTradesQuery, useAdminJobsQuery, useRetryJobAdminMutation, useTriggerCatalogSyncAdminMutation, useTriggerPriceSyncAdminMutation } from "../../api/admin-api";
import { ApiClientError } from "../../api/client";
import { ConfirmDialog, EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { useToast } from "../../providers/toast-provider";
import { formatDateTime, jobStatusLabel } from "./admin-format";
import styles from "./admin-shared.module.css";

/** I30F 任务与异常：只读复核失败任务与待复核风控，并允许二次确认地触发同步或重试。 */
export function AdminJobsPage() {
  const jobs = useAdminJobsQuery(undefined, 50);
  const exceptions = useAdminExceptionTradesQuery(50);
  if (jobs.isPending || exceptions.isPending) return <PageSkeleton label="正在加载任务与异常" />;
  if (jobs.isError) return <main className="page"><ErrorState title={jobs.error instanceof ApiClientError && jobs.error.code === "AUTHORIZATION_DENIED" ? "无权查看任务" : "任务加载失败"} onRetry={() => void jobs.refetch()} /></main>;
  if (!jobs.data) return <PageSkeleton label="正在确认任务访问权限" />;
  const jobItems = jobs.data.data.items;
  const reviewItems = exceptions.data?.data.items ?? [];
  return <main className={`page ${styles.page}`}>
    <h1>任务与异常</h1>
    <p className={styles.intro}>只读复核后台任务与待复核异常；重试与同步触发均为独立幂等意图，由服务端写入审计。完整运行日志可在日志页按任务类型筛选。</p>
    <SyncSection />
    <section className={styles.card}>
      <h2>待复核异常</h2>
      {reviewItems.length === 0 ? <EmptyState title="没有待复核异常">当前没有服务端标记的待复核项。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>时间</th><th>类型</th><th>状态</th><th>原因</th><th>实体</th></tr></thead><tbody>
        {reviewItems.map((item) => <tr key={`${item.kind}-${item.id}`}>
          <td>{formatDateTime(item.occurredAt)}</td>
          <td>{item.kind === "risk_flagged" ? "待复核风控" : "失败任务"}</td>
          <td><span className={item.kind === "failed_job" ? styles.failed : styles.flagged}>{item.status}</span></td>
          <td className={styles.mono}>{item.reason || "—"}</td>
          <td className={styles.mono}>{item.entityType} · {item.entityId}</td>
        </tr>)}
      </tbody></table></div>}
    </section>
    <section className={styles.card}>
      <h2>最近任务</h2>
      {jobItems.length === 0 ? <EmptyState title="暂无任务">尚未投递任何后台任务。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>任务 ID</th><th>类型</th><th>状态</th><th>尝试</th><th>更新时间</th><th>操作</th></tr></thead><tbody>
        {jobItems.map((job) => <JobRow key={job.id} job={job} />)}
      </tbody></table></div>}
      <p className={styles.intro}>任务运行历史与审计：<Link href="/admin/logs?taskType=catalog.sync">按任务类型筛选日志</Link>。</p>
    </section>
  </main>;
}

function SyncSection() {
  const catalog = useTriggerCatalogSyncAdminMutation();
  const prices = useTriggerPriceSyncAdminMutation();
  const { showToast } = useToast();
  const [confirm, setConfirm] = useState<null | "catalog" | "price">(null);
  const anyPending = catalog.isPending || prices.isPending;
  const submit = () => {
    if (confirm === "catalog") catalog.mutate(undefined, { onSuccess: () => showToast("目录同步任务已投递。"), onError: (error) => showToast(error instanceof Error ? error.message : "目录同步投递失败", "error") });
    if (confirm === "price") prices.mutate(undefined, { onSuccess: () => showToast("价格同步任务已投递。"), onError: (error) => showToast(error instanceof Error ? error.message : "价格同步投递失败", "error") });
    setConfirm(null);
  };
  return <section className={styles.card}>
    <h2>触发同步</h2>
    <p className={styles.intro}>同步仅由服务端后台任务访问外部数据源；失败会保留最近成功快照。这里只投递受控任务，浏览器不直接访问 Provider。</p>
    <div className={styles.actions}>
      <button className="button" type="button" disabled={anyPending} onClick={() => setConfirm("catalog")}>{catalog.isPending ? "提交中…" : "触发目录同步"}</button>
      <button className="button secondary" type="button" disabled={anyPending} onClick={() => setConfirm("price")}>{prices.isPending ? "提交中…" : "触发价格同步"}</button>
    </div>
    <ConfirmDialog open={confirm !== null} title={confirm === "catalog" ? "确认触发目录同步？" : "确认触发价格同步？"} description="服务器将创建受审计、可追踪的后台任务；浏览器不会直接访问外部数据源。" onCancel={() => setConfirm(null)} onConfirm={submit} />
  </section>;
}

function JobRow({ job }: { job: { id: string; type: string; status: string; attempt: number; maxAttempts: number; lastError: string | null; updatedAt: string } }) {
  const retry = useRetryJobAdminMutation();
  const { showToast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const canRetry = job.status === "failed" || job.status === "dead";
  return <>
    <tr>
      <td className={styles.mono}>{job.id}</td>
      <td>{job.type}</td>
      <td><span className={canRetry ? styles.failed : styles.published}>{jobStatusLabel(job.status)}</span></td>
      <td>{job.attempt} / {job.maxAttempts}</td>
      <td className={styles.mono}>{formatDateTime(job.updatedAt)}</td>
      <td>{canRetry ? <button className="button secondary" type="button" disabled={retry.isPending} onClick={() => setConfirm(true)}>{retry.isPending ? "重试中…" : "重试"}</button> : "—"}</td>
    </tr>
    {job.lastError ? <tr><td colSpan={6}><p className={styles.failure}>失败摘要：{job.lastError}</p></td></tr> : null}
    <ConfirmDialog open={confirm} title="确认重试任务？" description={`将把任务 ${job.id} 重新排队；不会删除既有运行记录。`} onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); retry.mutate(job.id, { onSuccess: () => showToast("任务已重新排队。"), onError: (error) => showToast(error instanceof Error ? error.message : "重试失败", "error") }); }} />
  </>;
}
