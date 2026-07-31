"use client";

import type { BackupRecordDto, BackupRestoreRehearsalDto } from "@mtg-market/contracts";
import { useState } from "react";
import { adminApi, useAdminBackupsQuery, useRestoreRehearsalAdminMutation, useTriggerBackupAdminMutation } from "../../api/admin-api";
import { ApiClientError } from "../../api/client";
import { ConfirmDialog, EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { useSession } from "../../providers/session-provider";
import { useToast } from "../../providers/toast-provider";
import { formatDateTime } from "./admin-format";
import styles from "./admin-shared.module.css";

const KIND_LABELS: Record<BackupRecordDto["kind"], string> = { scheduled: "定时", manual: "手动", predeploy: "部署前" };
const BACKUP_STATUS_LABELS: Record<BackupRecordDto["status"], string> = { running: "生成中", succeeded: "成功", failed: "失败" };

function kindLabel(kind: BackupRecordDto["kind"]): string {
  return KIND_LABELS[kind] ?? kind;
}

function statusLabel(status: BackupRecordDto["status"]): string {
  return BACKUP_STATUS_LABELS[status] ?? status;
}

function statusClass(status: BackupRecordDto["status"]): string {
  const cls = status === "failed" ? styles.failed : status === "running" ? styles.flagged : styles.published;
  return cls ?? "";
}

function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null || sizeBytes < 0) return "—";
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

/** SHA-256 只展示前 12 位摘要用于核对，完整哈希在详情/日志可追溯；不暴露源库路径。 */
function shaShort(sha256: string | null): string {
  return sha256 ? sha256.slice(0, 12) : "—";
}

/**
 * I31F 管理员备份状态页。只读展示服务端备份记录并提供受控下载与只读恢复演练；
 * 浏览器只下载服务端生成的 `attachment` 流，绝不接触源库绝对路径或 `BACKUP_DIR`。
 * 恢复演练是只读副本校验，绝不覆盖运行库（I31B 服务端保证）。
 */
export function AdminBackupsPage() {
  const backups = useAdminBackupsQuery(50);
  if (backups.isPending) return <PageSkeleton label="正在加载备份记录" />;
  if (backups.isError) return <main className="page"><ErrorState title={backups.error instanceof ApiClientError && backups.error.code === "AUTHORIZATION_DENIED" ? "无权查看备份" : "备份记录加载失败"} onRetry={() => void backups.refetch()} /></main>;
  if (!backups.data) return <PageSkeleton label="正在确认备份访问权限" />;
  const items = backups.data.data.items;
  const succeeded = items.filter((item) => item.status === "succeeded");
  const latest = succeeded[0] ?? null;
  return <main className={`page ${styles.page}`}>
    <h1>备份与恢复演练</h1>
    <p className={styles.intro}>SQLite 一致性备份由服务端后台任务生成（WAL 活跃写入时仍一致），并做 SHA-256 与完整性校验。下载只下发服务端生成的受控文件，不暴露内部存储路径；恢复演练在只读副本上校验，绝不覆盖运行库。</p>

    <section className={styles.statGrid} aria-label="备份摘要">
      <div className={styles.stat}><span>记录总数</span><strong>{items.length}</strong></div>
      <div className={styles.stat}><span>成功备份</span><strong>{succeeded.length}</strong></div>
      <div className={styles.stat}><span>最新成功时间</span><strong>{latest ? formatDateTime(latest.completedAt) : "—"}</strong></div>
      <div className={styles.stat}><span>最新成功 SHA-256</span><strong className={styles.mono}>{latest ? shaShort(latest.sha256) : "—"}</strong></div>
    </section>

    <TriggerSection />

    <section className={styles.card}>
      <h2>备份记录</h2>
      {items.length === 0 ? <EmptyState title="暂无备份记录">定时任务每日生成一次；也可手动或部署前触发。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>文件名</th><th>类型</th><th>状态</th><th>大小</th><th>完整性</th><th>SHA-256</th><th>完成时间</th><th>操作</th></tr></thead><tbody>
        {items.map((item) => <BackupRow key={item.id} record={item} />)}
      </tbody></table></div>}
      <p className={styles.notice}>保留策略由服务端执行（至少保留最近若干份成功备份，最新成功永不删）。失败记录仅追加，不会删除最近成功备份。</p>
    </section>
  </main>;
}

function TriggerSection() {
  const trigger = useTriggerBackupAdminMutation();
  const { showToast } = useToast();
  const [confirm, setConfirm] = useState<null | "manual" | "predeploy">(null);
  const submit = () => {
    if (!confirm) return;
    trigger.mutate(confirm, {
      onSuccess: (response) => { showToast(response.data.skipped ? "该意图已处理过，已展示既有备份记录。" : "备份任务已触发，可在列表中查看状态。"); setConfirm(null); },
      onError: (error) => { showToast(error instanceof Error ? error.message : "备份触发失败", "error"); setConfirm(null); }
    });
  };
  return <section className={styles.card}>
    <h2>触发备份</h2>
    <p className={styles.intro}>手动触发用于即时备份；部署前触发用于升级前的预备份。两者均要求独立幂等意图并写入审计。</p>
    <div className={styles.actions}>
      <button className="button" type="button" disabled={trigger.isPending} onClick={() => setConfirm("manual")}>{trigger.isPending ? "提交中…" : "手动备份"}</button>
      <button className="button secondary" type="button" disabled={trigger.isPending} onClick={() => setConfirm("predeploy")}>{trigger.isPending ? "提交中…" : "部署前备份"}</button>
    </div>
    <ConfirmDialog open={confirm !== null} title={confirm === "predeploy" ? "确认触发部署前备份？" : "确认触发手动备份？"} description="服务器将在事务外生成 WAL 一致副本并校验完整性；浏览器不接触源库路径。" onCancel={() => setConfirm(null)} onConfirm={submit} />
  </section>;
}

function BackupRow({ record }: { record: BackupRecordDto }) {
  const { accessToken } = useSession();
  const { showToast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const [confirmDownload, setConfirmDownload] = useState(false);
  const [confirmRehearsal, setConfirmRehearsal] = useState(false);
  const [rehearsal, setRehearsal] = useState<BackupRestoreRehearsalDto | null>(null);
  const rehearsalMutation = useRestoreRehearsalAdminMutation();
  const canDownload = record.status === "succeeded";
  const canRehearse = record.status === "succeeded";

  const runDownload = async () => {
    setDownloading(true);
    try {
      const result = await adminApi.downloadBackup(accessToken!, record.id, record.backupFileName ?? `backup-${record.id}`);
      showToast(`已开始下载 ${result.fileName}。`);
    } catch (error) {
      const message = error instanceof ApiClientError && error.code === "RESOURCE_CONFLICT" ? "该备份不可下载（未成功或文件已清理）。" : error instanceof Error ? error.message : "下载失败";
      showToast(message, "error");
    } finally {
      setDownloading(false);
      setConfirmDownload(false);
    }
  };

  const runRehearsal = () => {
    rehearsalMutation.mutate(record.id, {
      onSuccess: (response) => { setRehearsal(response.data.rehearsal); showToast("恢复演练已完成（只读校验）。"); },
      onError: (error) => { const message = error instanceof ApiClientError && error.code === "RESOURCE_CONFLICT" ? "仅成功备份可执行恢复演练。" : error instanceof Error ? error.message : "恢复演练失败"; showToast(message, "error"); },
      onSettled: () => setConfirmRehearsal(false)
    });
  };

  return <>
    <tr>
      <td className={styles.mono}>{record.backupFileName ?? "—"}</td>
      <td>{kindLabel(record.kind)}</td>
      <td><span className={`${styles.tag} ${statusClass(record.status)}`}>{statusLabel(record.status)}</span>{record.status === "failed" && record.failureReason ? <p className={styles.failure}>{record.failureReason}</p> : null}</td>
      <td>{formatSize(record.sizeBytes)}</td>
      <td>{record.sqliteIntegrityOk === null ? "—" : record.sqliteIntegrityOk ? "通过" : "失败"}</td>
      <td className={styles.mono}>{shaShort(record.sha256)}</td>
      <td className={styles.mono}>{formatDateTime(record.completedAt)}</td>
      <td><div className={styles.actions}>
        <button className="button secondary" type="button" disabled={!canDownload || downloading} onClick={() => setConfirmDownload(true)}>{downloading ? "下载中…" : "下载"}</button>
        <button className="button secondary" type="button" disabled={!canRehearse || rehearsalMutation.isPending} onClick={() => setConfirmRehearsal(true)}>{rehearsalMutation.isPending ? "演练中…" : "恢复演练"}</button>
      </div></td>
    </tr>
    <ConfirmDialog open={confirmDownload} title="确认下载备份文件？" description={`将下载服务端生成的 ${record.backupFileName ?? "备份"}；浏览器不会接触内部存储路径或源库。`} onCancel={() => setConfirmDownload(false)} onConfirm={runDownload} />
    <ConfirmDialog open={confirmRehearsal} title="确认执行恢复演练？" description="服务器将在只读副本上校验完整性与核心表，绝不覆盖运行库。" onCancel={() => setConfirmRehearsal(false)} onConfirm={runRehearsal} />
    {rehearsal ? <RehearsalDialog rehearsal={rehearsal} onClose={() => setRehearsal(null)} /> : null}
  </>;
}

function RehearsalDialog({ rehearsal, onClose }: { rehearsal: BackupRestoreRehearsalDto; onClose: () => void }) {
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="rehearsal-title">
      <h2 id="rehearsal-title">恢复演练结果（只读校验）</h2>
      <p className={styles.intro}>本次演练在只读副本上完成，未覆盖运行库。完整恢复需人工停服替换文件，步骤见运维文档。</p>
      <dl className={styles.details}>
        <div><dt>备份文件</dt><dd className={styles.mono}>{rehearsal.backupFileName}</dd></div>
        <div><dt>完整性校验</dt><dd>{rehearsal.sqliteIntegrityOk ? "通过" : "失败"}</dd></div>
        <div><dt>核心表存在</dt><dd>{rehearsal.coreTablesPresent ? "是" : "否"}</dd></div>
        <div><dt>采样行数</dt><dd>用户 {rehearsal.sampleCounts.users} · 账户 {rehearsal.sampleCounts.accounts} · 库存 {rehearsal.sampleCounts.inventoryHoldings} · 任务 {rehearsal.sampleCounts.jobs}</dd></div>
      </dl>
      <div className={styles.actions}><button className="button secondary" type="button" onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}
