"use client";

import type { CatalogSyncRunDto } from "@mtg-market/contracts";
import { useState } from "react";
import { useCacheCatalogImageMutation, useCatalogSyncStatusQuery, useRetryCatalogSyncMutation, useTriggerCatalogSyncMutation } from "../../api/admin-catalog-sync-api";
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
  const status = useCatalogSyncStatusQuery(); const trigger = useTriggerCatalogSyncMutation(); const cacheImage = useCacheCatalogImageMutation(); const retry = useRetryCatalogSyncMutation(); const { showToast } = useToast();
  const [action, setAction] = useState<"trigger" | "retry" | "single-image" | "set-images" | null>(null);
  const [skuId, setSkuId] = useState(""); const [setCode, setSetCode] = useState("");
  if (status.isPending) return <PageSkeleton label="正在加载目录同步状态" />;
  if (status.isError) return <main className="page"><ErrorState title={status.error instanceof ApiClientError && status.error.code === "AUTHORIZATION_DENIED" ? "无权查看目录同步" : "目录同步状态加载失败"} onRetry={() => void status.refetch()} /></main>;
  const data = status.data.data; const job = data.currentJob; const imageJob = data.currentImageCacheJob; const actionPending = trigger.isPending || cacheImage.isPending || retry.isPending;
  const canRetry = job?.status === "failed" || job?.status === "dead";
  const submit = () => {
    if (action === "trigger") trigger.mutate(undefined, { onSuccess: () => showToast("目录同步任务已提交，可在此页持续追踪。"), onError: (error) => showToast(error instanceof Error ? error.message : "目录同步任务提交失败", "error") });
    if (action === "retry" && job) retry.mutate(job.id, { onSuccess: () => showToast("失败任务已重新排队。"), onError: (error) => showToast(error instanceof Error ? error.message : "重试任务提交失败", "error") });
    if (action === "single-image") cacheImage.mutate({ scope: "single", skuId: skuId.trim() }, { onSuccess: () => { setSkuId(""); showToast("单张卡图缓存任务已提交。"); }, onError: (error) => showToast(error instanceof Error ? error.message : "图片缓存任务提交失败", "error") });
    if (action === "set-images") cacheImage.mutate({ scope: "set", setCode: setCode.trim().toUpperCase() }, { onSuccess: () => { setSetCode(""); showToast("系列卡图缓存任务已提交。"); }, onError: (error) => showToast(error instanceof Error ? error.message : "图片缓存任务提交失败", "error") });
    setAction(null);
  };
  return <main className={`page ${styles.page}`}><p className="eyebrow">本地管理 API</p><h1>目录同步</h1><p className="intro">同步仅由服务器后台任务访问 Scryfall。失败不会删除最近一次成功的本地目录，玩家可继续浏览旧资料。</p>
    <section className={styles.card}><h2>当前任务</h2>{job ? <dl className={styles.details}><div><dt>状态</dt><dd>{statusLabel(job.status)}</dd></div><div><dt>任务编号</dt><dd className={styles.mono}>{job.id}</dd></div><div><dt>尝试次数</dt><dd>{job.attempt} / {job.maxAttempts}</dd></div><div><dt>更新时间</dt><dd>{date(job.updatedAt)}</dd></div></dl> : <p>尚未投递目录同步任务。</p>}{job?.lastError ? <p className={styles.failure} role="alert">任务失败摘要：{job.lastError}</p> : null}<div className="actions"><button className="button" disabled={actionPending || job?.status === "pending" || job?.status === "running"} onClick={() => setAction("trigger")}>{actionPending ? "正在提交…" : "触发目录同步"}</button>{canRetry ? <button className="button secondary" disabled={actionPending} onClick={() => setAction("retry")}>重试失败任务</button> : null}</div></section>
    <section className={styles.card}><h2>卡图本地缓存</h2><p>卡图下载是独立后台任务，不会重新下载 Bulk 文件或替换目录。单张操作使用目录详情中的 SKU ID；系列操作会补齐该系列所有缺失或失败的 Scryfall 卡图。</p>{imageJob ? <dl className={styles.details}><div><dt>最近图片任务</dt><dd>{statusLabel(imageJob.status)}</dd></div><div><dt>任务编号</dt><dd className={styles.mono}>{imageJob.id}</dd></div><div><dt>尝试次数</dt><dd>{imageJob.attempt} / {imageJob.maxAttempts}</dd></div><div><dt>更新时间</dt><dd>{date(imageJob.updatedAt)}</dd></div></dl> : <p>尚未投递图片缓存任务。</p>}{imageJob?.lastError ? <p className={styles.failure} role="alert">图片任务失败摘要：{imageJob.lastError}</p> : null}<div className={styles.cacheActions}><label>单张 SKU ID<input aria-label="单张图片 SKU ID" value={skuId} onChange={(event) => setSkuId(event.target.value)} placeholder="目录详情中的 SKU UUID" /></label><button className="button secondary" disabled={actionPending || skuId.trim().length === 0} onClick={() => setAction("single-image")}>缓存单张图片</button><label>系列代码<input aria-label="批量图片系列代码" value={setCode} onChange={(event) => setSetCode(event.target.value)} placeholder="例如 ONE" /></label><button className="button secondary" disabled={actionPending || setCode.trim().length === 0} onClick={() => setAction("set-images")}>缓存系列图片</button></div></section>
    <RunSummary title="最近成功版本" run={data.latestSuccessful} /><RunSummary title="当前或最近一次运行" run={data.current} />
    {!data.latestSuccessful && data.current?.status === "failed" ? <EmptyState title="旧目录保留状态">本次同步失败，未替换任何目录资料；请根据失败摘要修复后重试。</EmptyState> : null}
    <ConfirmDialog open={action !== null} title={action === "retry" ? "确认重试目录同步？" : action === "single-image" ? "确认缓存单张卡图？" : action === "set-images" ? "确认缓存整个系列的卡图？" : "确认触发目录同步？"} description={action === "retry" ? "将把失败任务重新排队，并继续保留当前本地目录。" : action === "single-image" ? "服务器将只读取该 SKU 已同步的 Scryfall 图片地址并写入本地缓存。" : action === "set-images" ? `服务器将后台补齐系列 ${setCode.trim().toUpperCase()} 的缺失卡图，不会重新导入目录。` : "服务器将创建受审计、可追踪的后台任务；浏览器不会直接访问 Scryfall。"} onCancel={() => setAction(null)} onConfirm={submit} />
  </main>;
}
