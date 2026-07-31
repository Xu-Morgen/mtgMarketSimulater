/** I31B 导出记录领域模型。文件路径相对 EXPORT_DIR，不外泄给浏览器。 */
export interface ExportRecord {
  id: string;
  userId: string;
  kind: "all";
  format: "csv" | "json";
  fileName: string;
  filePathRelative: string;
  sizeBytes: number | null;
  expiresAt: string;
  status: "running" | "succeeded" | "failed" | "expired";
  failureReason: string | null;
  requestId: string | null;
  idempotencyKey: string;
  createdAt: string;
  completedAt: string | null;
}
