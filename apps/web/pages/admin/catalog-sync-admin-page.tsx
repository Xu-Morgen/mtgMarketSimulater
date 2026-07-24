"use client";

import type { CatalogSyncRunDto } from "@mtg-market/contracts";
import { useState } from "react";
import { useCatalogSyncStatusQuery, useRetryCatalogSyncMutation, useTriggerCatalogSyncMutation } from "../../api/admin-catalog-sync-api";
import { ApiClientError } from "../../api/client";
import { ConfirmDialog, EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { useToast } from "../../providers/toast-provider";
import styles from "./catalog-sync-admin-page.module.css";

function date(value: string | null): string { return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value)) : "未完成"; }
function statusLabel(status: string): string { return ({ pending: "等待执行", running: "执行中", succeeded: "已成功", failed: "失败，可重试", dead: "失败，需重试" })[status] ?? status; }
function RunSummary({ title, run }: { title: string; run: CatalogSyncRunDto | null }) {
  if (!run) return <section className="status-card"><h2>{title}</h2><p>暂无记录。</p></section>;
  return <section className={styles.card}><h2>{title}</h2><dl className={styles.details}><div><dt>状态</dt><dd>{statusLabel(run.status)}</dd></div><div><dt>版本</dt><dd>{run.sourceVersion}</dd></div><div><dt>开始时间</dt><dd>{date(run.startedAt)}</dd></div><div><dt>完成时间</dt><dd>{date(run.completedAt)}</dd></div><div><dt>差异</dt><dd>新增/导入 {run.diff.added ?? run.importedPrintings} 张印刷，移除 {run.diff.removed ?? 0} 张；{run.importedSkus} 个 SKU</dd></div><div><dt>启用系列</dt><dd>{run.enabledSetCodes.join("、") || "未记录"}</dd></div></dl>{run.failureReason ? <p className={styles.failure} role="alert">失败摘要：{run.failureReason}</p> : null}</section>;
}

export function CatalogSyncAdminPage() {
  const status = useCatalogSyncStatusQuery(); const trigger = useTriggerCatalogSyncMutation(); const retry = useRetryCatalogSyncMutation(); const { showToast } = useToast();
  const [action, setAction] = useState<"trigger" | "retry" | null>(null);
  if (status.isPending) return <PageSkeleton label="正在加载目录同步状态" />;
  if (status.isError) return <main className="page"><ErrorState title={status.error instanceof ApiClientError && status.error.code === "AUTHORIZATION_DENIED" ? "无权查看目录同步" : "目录同步状态加载失败"} onRetry={() => void status.refetch()} /></main>;
  const data = status.data.data; const job = data.currentJob; const actionPending = trigger.isPending || retry.isPending;
  const canRetry = job?.status === "failed" || job?.status === "dead";
  const submit = () => {
    if (action === "trigger") trigger.mutate(undefined, { onSuccess: () => showToast("目录同步任务已提交，可在此页持续追踪。"), onError: (error) => showToast(error instanceof Error ? error.message : "目录同步任务提交失败", "error") });
    if (action === "retry" && job) retry.mutate(job.id, { onSuccess: () => showToast("失败任务已重新排队。"), onError: (error) => showToast(error instanceof Error ? error.message : "重试任务提交失败", "error") });
    setAction(null);
  };
  return <main className={`page ${styles.page}`}><p className="eyebrow">本地管理 API</p><h1>目录同步</h1><p className="intro">同步仅由服务器后台任务访问 Scryfall。失败不会删除最近一次成功的本地目录，玩家可继续浏览旧资料。</p>
    <section className={styles.card}><h2>当前任务</h2>{job ? <dl className={styles.details}><div><dt>状态</dt><dd>{statusLabel(job.status)}</dd></div><div><dt>任务编号</dt><dd className={styles.mono}>{job.id}</dd></div><div><dt>尝试次数</dt><dd>{job.attempt} / {job.maxAttempts}</dd></div><div><dt>更新时间</dt><dd>{date(job.updatedAt)}</dd></div></dl> : <p>尚未投递目录同步任务。</p>}{job?.lastError ? <p className={styles.failure} role="alert">任务失败摘要：{job.lastError}</p> : null}<div className="actions"><button className="button" disabled={actionPending || job?.status === "pending" || job?.status === "running"} onClick={() => setAction("trigger")}>{actionPending ? "正在提交…" : "触发目录同步"}</button>{canRetry ? <button className="button secondary" disabled={actionPending} onClick={() => setAction("retry")}>重试失败任务</button> : null}</div></section>
    <RunSummary title="最近成功版本" run={data.latestSuccessful} /><RunSummary title="当前或最近一次运行" run={data.current} />
    {!data.latestSuccessful && data.current?.status === "failed" ? <EmptyState title="旧目录保留状态">本次同步失败，未替换任何目录资料；请根据失败摘要修复后重试。</EmptyState> : null}
    <ConfirmDialog open={action !== null} title={action === "retry" ? "确认重试目录同步？" : "确认触发目录同步？"} description={action === "retry" ? "将把失败任务重新排队，并继续保留当前本地目录。" : "服务器将创建受审计、可追踪的后台任务；浏览器不会直接访问 Scryfall。"} onCancel={() => setAction(null)} onConfirm={submit} />
  </main>;
}
