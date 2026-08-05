import { naturalDateAt } from "../../users/domain/natural-day.js";

/** 每日任务周期键：服务端 IANA 时区的自然日（YYYY-MM-DD），与每日工作资金共用同一派生。 */
export function dayPeriodKey(now: Date, timezone: string): string {
  return naturalDateAt(now, timezone);
}

/**
 * 每周任务周期键：ISO 8601 周（YYYY-Www，周一为一周之始）。先按服务端时区取自然日，
 * 再以纯日历计算该日所在 ISO 周；浏览器时间不参与周期判定。停机补跑/跨年由规则保证
 * 稳定周键（同一自然周始终映射同一键）。
 */
export function weekPeriodKey(now: Date, timezone: string): string {
  const naturalDate = naturalDateAt(now, timezone);
  const [year, month, day] = naturalDate.split("-").map(Number);
  // Date.UTC 得到该自然日对应的 UTC 时刻（自然日已在目标时区，直接用本地字段构造 UTC 序数）。
  const date = new Date(Date.UTC(year!, month! - 1, day!));
  const dayOfWeek = date.getUTCDay() === 0 ? 7 : date.getUTCDay(); // 周一=1 … 周日=7
  // ISO 周：周四所在年即周所属年；先用周四校准。
  const thursday = new Date(Date.UTC(year!, month! - 1, day! + (4 - dayOfWeek)));
  const isoYear = thursday.getUTCFullYear();
  // 该年 1 月 4 日所在周为第 1 周；计算周四相对该周的偏移。
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4Day = jan4.getUTCDay() === 0 ? 7 : jan4.getUTCDay();
  const week1Monday = new Date(Date.UTC(isoYear, 0, 4 - (jan4Day - 1)));
  const weekNumber = Math.floor((thursday.getTime() - week1Monday.getTime()) / (7 * 24 * 60 * 60 * 1_000)) + 1;
  const padded = String(weekNumber).padStart(2, "0");
  return `${isoYear}-W${padded}`;
}
