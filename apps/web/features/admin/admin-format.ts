import type { CampaignStatus, MtgjsonDraftStatus, MtgjsonDraftMappingStatus } from "@mtg-market/contracts";

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  try { return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
  catch { return value; }
}

export function jobStatusLabel(status: string): string {
  return ({ pending: "等待执行", running: "执行中", succeeded: "已成功", failed: "失败", dead: "失败，需重试" })[status] ?? status;
}

export function campaignStatusLabel(status: CampaignStatus): string {
  return ({ draft: "草稿", previewing: "预览中", published: "已发布", paused: "已暂停", ended: "已结束" })[status] ?? status;
}

export function draftStatusLabel(status: MtgjsonDraftStatus): string {
  return ({ draft: "草稿", validated: "已校验", published: "已发布", discarded: "已丢弃" })[status] ?? status;
}

export function mappingStatusLabel(status: MtgjsonDraftMappingStatus): string {
  return ({ pending: "待映射", mapped: "已映射", missing: "缺失", conflict: "冲突" })[status] ?? status;
}

export function freshnessLabel(status: "fresh" | "stale" | "unavailable"): string {
  return ({ fresh: "新鲜", stale: "过期", unavailable: "不可用" })[status];
}

/** 把审计摘要 JSON 以缩进文本展示，便于排障且不渲染未知结构。 */
export function summarizeSummary(summary: Record<string, unknown>): string {
  try { return JSON.stringify(summary, null, 2); }
  catch { return String(summary); }
}

/** bps → 百分比展示，仅用于展示市场因子等参数。 */
export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
