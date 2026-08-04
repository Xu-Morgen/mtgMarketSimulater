import type { PackOfferDto } from "@mtg-market/contracts";

/**
 * I33F 限时/特殊包展示的纯格式化函数。只影响视觉提示（折扣标签、剩余时间），
 * 购买资格与窗口状态一律以服务端 `PackDto.offer.status` 与购买预览为准。
 */

/** 折扣标签，例如 -20%；10_000 bp 表示无折扣，返回空字符串。 */
export function offerDiscountPercent(offer: PackOfferDto): string {
  if (offer.discountBps >= 10_000) return "";
  const percent = Math.round((1 - offer.discountBps / 10_000) * 100);
  return percent > 0 ? `-${percent}%` : "";
}

function durationText(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${Math.max(1, minutes)} 分`;
}

/** 服务端窗口剩余时间的展示文案；`now` 为浏览器当前时间戳，只用于倒计时视觉。 */
export function offerCountdownText(offer: PackOfferDto, now: number): string {
  if (offer.status === "scheduled") {
    const diff = new Date(offer.startsAt).getTime() - now;
    if (diff <= 0) return "窗口刚刚开启，请刷新查看";
    return `距开售约 ${durationText(diff)}`;
  }
  if (offer.status !== "active") return "该限时销售窗口已结束";
  const diff = new Date(offer.endsAt).getTime() - now;
  if (diff <= 0) return "窗口即将结束，请刷新确认服务端状态";
  return `剩余约 ${durationText(diff)}`;
}

/** 未开始/已结束窗口的固定拒绝原因（与购买预览失败语义一致），供卡片禁用提示使用。 */
export function offerUnavailableReason(offer: PackOfferDto | null): string | null {
  if (!offer) return null;
  if (offer.status === "scheduled") return "该限时包尚未开售（未到服务端销售窗口）。";
  if (offer.status === "ended") return "该限时包的销售窗口已结束，当前不可购买。";
  return null;
}
