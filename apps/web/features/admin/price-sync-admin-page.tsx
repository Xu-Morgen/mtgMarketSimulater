"use client";

import type { PriceSyncRunDto } from "@mtg-market/contracts";
import { useEffect, useState } from "react";
import { useAdminPriceSyncStatusQuery, useTriggerPriceSyncMutation } from "../../api/pricing-api";
import { ApiClientError } from "../../api/client";
import { ConfirmDialog, EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { useToast } from "../../providers/toast-provider";
import styles from "./price-sync-admin-page.module.css";

function date(value: string | null): string {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "未完成";
}
function statusLabel(status: string): string {
  return ({ pending: "等待执行", running: "执行中", succeeded: "已成功", failed: "失败", dead: "失败，需重试" })[status] ?? status;
}
function RunSummary({ title, run }: { title: string; run: PriceSyncRunDto | null }) {
  if (!run) return <section className="status-card"><h2>{title}</h2><p>暂无记录。</p></section>;
  return <section className={styles.card}>
    <h2>{title}</h2>
    <dl className={styles.details}>
      <div><dt>状态</dt><dd>{statusLabel(run.status)}</dd></div>
      <div><dt>校验状态</dt><dd>{run.checksumVerification === "verified" ? "已验证" : run.checksumVerification === "bypassed" ? "管理员已确认绕过" : "未完成验证"}</dd></div>
      <div><dt>数据版本</dt><dd>{run.sourceVersion}</dd></div>
      <div><dt>价格文件校验和</dt><dd className={styles.mono}>{run.pricesChecksumSha256}</dd></div>
      <div><dt>映射文件校验和</dt><dd className={styles.mono}>{run.mappingChecksumSha256}</dd></div>
      <div><dt>开始时间</dt><dd>{date(run.startedAt)}</dd></div>
      <div><dt>完成时间</dt><dd>{date(run.completedAt)}</dd></div>
      <div><dt>映射成功</dt><dd>{run.mappedSkus} 个 SKU</dd></div>
      <div><dt>有有效参考价</dt><dd>{run.pricedSkus} 个 SKU</dd></div>
      <div><dt>无价</dt><dd>{run.unpricedSkus} 个 SKU</dd></div>
      <div><dt>映射失败</dt><dd>{run.mappingFailedSkus} 个 SKU</dd></div>
    </dl>
    {run.failureReason ? <p className={styles.failure} role="alert">失败摘要：{run.failureReason}</p> : null}
  </section>;
}

export function PriceSyncAdminPage() {
  const status = useAdminPriceSyncStatusQuery(); const trigger = useTriggerPriceSyncMutation(); const { showToast } = useToast(); const [confirmRefresh, setConfirmRefresh] = useState(false); const [confirmBypass, setConfirmBypass] = useState(false); const [dismissedBypassRunId, setDismissedBypassRunId] = useState<string | null>(null);
  const data = status.data?.data;
  const currentRunId = data?.current?.id ?? null;
  const taskPending = data?.currentJob?.status === "pending" || data?.currentJob?.status === "running";
  useEffect(() => {
    if (data?.checksumBypassAvailable && currentRunId && currentRunId !== dismissedBypassRunId && !taskPending) setConfirmBypass(true);
  }, [currentRunId, data?.checksumBypassAvailable, dismissedBypassRunId, taskPending]);
  if (status.isPending) return <PageSkeleton label="正在加载价格同步状态" />;
  if (status.isError) return <main className="page"><ErrorState title={status.error instanceof ApiClientError && status.error.code === "AUTHORIZATION_DENIED" ? "无权查看价格同步状态" : "价格同步状态加载失败"} onRetry={() => void status.refetch()} /></main>;
  // 路由布局会处理非管理员跳转；这里仍不得在禁用查询时解引用空数据。
  if (!status.data) return <PageSkeleton label="正在确认价格同步访问权限" />;
  const loaded = status.data.data;
  const submitRefresh = () => trigger.mutate({}, {
    onSuccess: () => showToast("当日价格同步任务已提交，可在此页持续追踪。"),
    onError: (error) => showToast(error instanceof Error ? error.message : "价格同步任务提交失败", "error")
  });
  const submitChecksumBypass = () => trigger.mutate({ allowChecksumMismatch: true }, {
    onSuccess: () => showToast("已提交未校验价格覆写任务；完成后会明确标记为管理员绕过。"),
    onError: (error) => showToast(error instanceof Error ? error.message : "未校验价格覆写任务提交失败", "error")
  });
  return <main className={`page ${styles.page}`}>
    <p className="eyebrow">本地管理 API</p><h1>价格同步状态</h1>
    <p className="intro">Cardmarket EUR 仅为 MTGJSON 每日外部参考快照，不是实时价格，也不等同于游戏内报价。下载地址和原始 Provider 内容不会显示给浏览器。</p>
    <section className={styles.card}><h2>最近价格同步任务</h2>{loaded.currentJob ? <dl className={styles.details}>
      <div><dt>状态</dt><dd>{statusLabel(loaded.currentJob.status)}</dd></div><div><dt>任务编号</dt><dd className={styles.mono}>{loaded.currentJob.id}</dd></div>
      <div><dt>尝试次数</dt><dd>{loaded.currentJob.attempt} / {loaded.currentJob.maxAttempts}</dd></div><div><dt>更新时间</dt><dd>{date(loaded.currentJob.updatedAt)}</dd></div>
    </dl> : <p>尚未投递价格同步任务。</p>}{loaded.currentJob?.lastError ? <p className={styles.failure} role="alert">任务失败摘要：{loaded.currentJob.lastError}</p> : null}<div className="actions"><button className="button" disabled={trigger.isPending || taskPending} onClick={() => setConfirmRefresh(true)}>{trigger.isPending ? "正在提交…" : taskPending ? "同步任务执行中" : "主动刷新当日价格"}</button></div></section>
    <RunSummary title="最近成功快照" run={loaded.latestSuccessful} />
    <RunSummary title="当前或最近一次运行" run={loaded.current} />
    {loaded.latestSuccessful && loaded.current?.status === "failed" ? <EmptyState title="已保留最近成功快照">本次同步失败不会删除已有外部参考快照；玩家侧会明确标记为过期，待修复后以新的受控任务同步。</EmptyState> : null}
    {!loaded.latestSuccessful && loaded.current?.status === "failed" ? <EmptyState title="尚无可用价格快照">本次同步失败且没有历史成功快照；无价或映射失败 SKU 均不能新增交易。</EmptyState> : null}
    <ConfirmDialog open={confirmRefresh} title="确认刷新当日价格？" description="服务器将以新的受审计任务下载并校验 MTGJSON 当日价格。失败时会保留最近成功快照，浏览器不会直接访问数据源。" onCancel={() => setConfirmRefresh(false)} onConfirm={() => { setConfirmRefresh(false); submitRefresh(); }} />
    <ConfirmDialog open={confirmBypass} title="检测到校验和不匹配" description="上游文件与其 SHA-256 校验和不一致。继续将直接使用未验证的下载价格，并写入管理员覆写审计；这可能引入不完整或过期数据。" onCancel={() => { setConfirmBypass(false); setDismissedBypassRunId(currentRunId); }} onConfirm={() => { setConfirmBypass(false); setDismissedBypassRunId(currentRunId); submitChecksumBypass(); }} />
  </main>;
}
