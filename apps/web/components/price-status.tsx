import { Tag } from "antd";
import type { PublicPriceStatusDto } from "@mtg-market/contracts";

function date(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

/** 统一展示服务端已脱敏的价格来源与 SKU 可交易状态；不显示价格金额或同步运行详情。 */
export function PriceStatus({ status, tradable }: { status: PublicPriceStatusDto | undefined | null; tradable: boolean }) {
  if (status === undefined) return <span aria-busy="true">价格状态加载中…</span>;
  if (status === null) return <Tag color="default">价格状态暂不可读取</Tag>;
  const source = status.source === "mtgjson-cardmarket" ? "MTGJSON / Cardmarket EUR 参考价" : "暂无可用外部参考价";
  const freshness = status.freshness === "fresh" ? "数据正常" : status.freshness === "stale" ? "同步失败，沿用旧快照" : "暂无成功快照";
  return <div>
    <div>{source}</div>
    <small>{status.updatedAt ? `更新时间：${date(status.updatedAt)}；${freshness}` : freshness}</small>
    <div><Tag color={tradable ? "green" : "red"}>{tradable ? "可新增交易" : "无有效参考价，暂不可新增交易"}</Tag></div>
    <small className="price-disclaimer">{status.disclaimer}</small>
  </div>;
}
