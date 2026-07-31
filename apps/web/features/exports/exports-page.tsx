"use client";

import type { ExportRecordDto } from "@mtg-market/contracts";
import { useState } from "react";
import { exportApi, useExportsQuery, useGenerateExportsMutation } from "../../api/export-api";
import { ApiClientError } from "../../api/client";
import { ConfirmDialog, EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { useSession } from "../../providers/session-provider";
import { useToast } from "../../providers/toast-provider";
import { formatDateTime } from "../admin/admin-format";
import styles from "./exports-page.module.css";

const ALL_FORMATS = ["csv", "json"] as const;
type ExportFormat = (typeof ALL_FORMATS)[number];

const STATUS_LABELS: Record<ExportRecordDto["status"], string> = { running: "生成中", succeeded: "可下载", failed: "失败", expired: "已过期" };

function statusLabel(status: ExportRecordDto["status"]): string {
  return STATUS_LABELS[status] ?? status;
}

function statusClass(status: ExportRecordDto["status"]): string {
  return styles[status] ?? styles.expired ?? "";
}

/** 字节数展示为人类可读单位；服务端以最小货币单位的整数存储，这里只做展示。 */
function formatSize(sizeBytes: number | null): string {
  if (sizeBytes === null || sizeBytes < 0) return "—";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(1)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * I31F 玩家数据导出页。只读展示服务端生成的导出记录并提交生成/下载意图；
 * 浏览器不拼装 CSV、不推导报表内容，只下载服务端 `attachment` 流（文件名来自服务端记录）。
 * 用户隔离、CSV 公式注入防护与字段稳定由 I31B 服务端保证。
 */
export function ExportsPage() {
  const exports = useExportsQuery();
  const generate = useGenerateExportsMutation();
  const { showToast } = useToast();
  const [formats, setFormats] = useState<ExportFormat[]>(["csv"]);
  const [confirmGenerate, setConfirmGenerate] = useState(false);

  if (exports.isPending) return <PageSkeleton label="正在加载导出记录" />;
  if (exports.isError) return <main className="page"><ErrorState title="导出记录加载失败" onRetry={() => void exports.refetch()} /></main>;

  const items = exports.data.data.items;
  const toggleFormat = (format: ExportFormat) => setFormats((prev) => prev.includes(format) ? prev.filter((item) => item !== format) : [...prev, format]);
  const submitGenerate = () => generate.mutate(formats, {
    onSuccess: (response) => {
      showToast(response.data.skipped ? "该意图已处理过，已展示既有导出记录。" : "导出已生成，可在列表中下载。");
      setConfirmGenerate(false);
    },
    onError: (error) => { showToast(error instanceof Error ? error.message : "导出生成失败", "error"); setConfirmGenerate(false); }
  });

  return <main className={`page ${styles.page}`}>
    <p className="eyebrow">服务端生成</p>
    <h1>我的数据导出</h1>
    <p className={styles.intro}>导出包含库存、账本、NPC 交易、P2P 委托与成交、开包和比赛的经营报表，由服务端按你的账户隔离生成并做 CSV 公式注入防护。下载只下发服务端生成的受控文件，不暴露内部存储路径；过期文件会被自动清理。</p>

    <section className={styles.card}>
      <h2>生成新导出</h2>
      <p className={styles.intro}>至少选择一种格式。每次生成使用独立幂等意图；同一网络重试不会重复生成。</p>
      <div className={styles.formatPick} role="group" aria-label="导出格式">
        {ALL_FORMATS.map((format) => <label key={format}><input type="checkbox" checked={formats.includes(format)} onChange={() => toggleFormat(format)} aria-label={`格式 ${format.toUpperCase()}`} />{format.toUpperCase()}</label>)}
      </div>
      <div className={styles.actions}>
        <button className="button" type="button" disabled={formats.length === 0 || generate.isPending} onClick={() => setConfirmGenerate(true)}>{generate.isPending ? "提交中…" : "生成导出"}</button>
      </div>
      <ConfirmDialog open={confirmGenerate} title="确认生成导出？" description={`将以 ${formats.map((format) => format.toUpperCase()).join("、")} 格式生成全部经营报表；CSV 已做公式注入防护。`} onCancel={() => setConfirmGenerate(false)} onConfirm={submitGenerate} />
    </section>

    <section className={styles.card}>
      <h2>导出记录</h2>
      {items.length === 0 ? <EmptyState title="暂无导出记录">生成后将在这里显示状态与下载入口。</EmptyState> : <div className={styles.tableWrap}><table><thead><tr><th>文件名</th><th>格式</th><th>状态</th><th>大小</th><th>过期时间</th><th>生成时间</th><th>操作</th></tr></thead><tbody>
        {items.map((item) => <ExportRow key={item.id} record={item} />)}
      </tbody></table></div>}
      <p className={styles.notice}>下载失败时（如文件已过期或被清理）服务端会返回 404；请重新生成。导出文件不可在浏览器中预览或编辑。</p>
    </section>
  </main>;
}

function ExportRow({ record }: { record: ExportRecordDto }) {
  const { accessToken } = useSession();
  const { showToast } = useToast();
  const [downloading, setDownloading] = useState(false);
  const [confirmDownload, setConfirmDownload] = useState(false);
  const canDownload = record.status === "succeeded";

  const runDownload = async () => {
    setDownloading(true);
    try {
      const result = await exportApi.download(accessToken!, record.id, record.fileName);
      showToast(`已开始下载 ${result.fileName}。`);
    } catch (error) {
      const message = error instanceof ApiClientError && (error.code === "RESOURCE_NOT_FOUND") ? "文件不存在、已过期或不可下载，请重新生成。" : error instanceof Error ? error.message : "下载失败";
      showToast(message, "error");
    } finally {
      setDownloading(false);
      setConfirmDownload(false);
    }
  };

  return <tr>
    <td className={styles.mono}>{record.fileName}</td>
    <td>{record.format.toUpperCase()}</td>
    <td><span className={`${styles.tag} ${statusClass(record.status)}`}>{statusLabel(record.status)}</span>{record.status === "failed" && record.failureReason ? <p className={styles.failure}>{record.failureReason}</p> : null}</td>
    <td>{formatSize(record.sizeBytes)}</td>
    <td className={styles.mono}>{formatDateTime(record.expiresAt)}</td>
    <td className={styles.mono}>{formatDateTime(record.createdAt)}</td>
    <td>{canDownload ? <button className="button secondary" type="button" disabled={downloading} onClick={() => setConfirmDownload(true)}>{downloading ? "下载中…" : "下载"}</button> : <span className={styles.disabledEntry} aria-label="不可下载">{record.status === "expired" ? "已过期" : record.status === "failed" ? "失败" : "生成中"}</span>}</td>
    <ConfirmDialog open={confirmDownload} title="确认下载导出文件？" description={`将下载服务端生成的 ${record.fileName}；浏览器不会接触内部存储路径。`} onCancel={() => setConfirmDownload(false)} onConfirm={runDownload} />
  </tr>;
}
