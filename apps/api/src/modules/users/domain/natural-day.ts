/** 服务器自然日只能由显式 IANA 时区和可注入时钟派生，浏览器时间不参与资格判定。 */
export function naturalDateAt(now: Date, timezone: string): string {
  if (!Number.isFinite(now.getTime())) throw new RangeError("时钟时间无效");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value("year"); const month = value("month"); const day = value("day");
  if (!year || !month || !day) throw new RangeError("无法按服务器时区解析自然日");
  return `${year}-${month}-${day}`;
}

/** 以纯日历运算取得下一自然日，避免 DST 使简单加 24 小时落在错误日期。 */
export function nextNaturalDate(naturalDate: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(naturalDate)) throw new RangeError("自然日格式无效");
  const [year, month, day] = naturalDate.split("-").map(Number);
  const utc = new Date(Date.UTC(year!, month! - 1, day! + 1));
  return utc.toISOString().slice(0, 10);
}

/**
 * 返回目标自然日开始的 UTC 时刻。二分搜索本地日期单调跨越点，因而能覆盖夏令时
 * 23/25 小时日和非整点偏移；结果仅用于展示下一次服务器资格开放时间。
 */
export function startOfNaturalDate(naturalDate: string, timezone: string): string {
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(naturalDate);
  if (!matched) throw new RangeError("自然日格式无效");
  const year = Number(matched[1]); const month = Number(matched[2]); const day = Number(matched[3]);
  const calendarProbe = new Date(Date.UTC(year, month - 1, day));
  if (calendarProbe.toISOString().slice(0, 10) !== naturalDate) throw new RangeError("自然日格式无效");
  const target = naturalDate;
  // 先触发 IANA 时区验证；目标可以是过去的日期，不能用当前日期替代。
  naturalDateAt(new Date(), timezone);
  let low = Date.UTC(year, month - 1, day - 2);
  let high = Date.UTC(year, month - 1, day + 2);
  while (naturalDateAt(new Date(low), timezone) >= target) low -= 24 * 60 * 60 * 1_000;
  while (naturalDateAt(new Date(high), timezone) < target) high += 24 * 60 * 60 * 1_000;
  while (high - low > 1) {
    const middle = low + Math.floor((high - low) / 2);
    if (naturalDateAt(new Date(middle), timezone) < target) low = middle;
    else high = middle;
  }
  return new Date(high).toISOString();
}
