"use client";

import type { OrderRiskDecisionDto } from "@mtg-market/contracts";
import { useState } from "react";
import { useOrderRiskDecisionsQuery, type OrderRiskDecisionFilters } from "../../api/orders-api";
import { ApiClientError } from "../../api/client";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import styles from "./order-risk-admin-page.module.css";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(new Date(value));
}

function outcomeLabel(outcome: OrderRiskDecisionDto["outcome"]): string {
  return outcome === "blocked" ? "已拦截" : outcome === "flagged" ? "待复核" : "已允许";
}

function actionLabel(action: OrderRiskDecisionDto["action"]): string {
  return action === "create" ? "创建委托" : action === "cancel" ? "撤单" : "撮合";
}

function reasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    price_out_of_band: "限价越界",
    cooldown: "下单冷却中",
    order_frequency: "下单频率过高",
    quantity_limit: "交易数量超限",
    self_trade: "可能自买自卖",
    cancellation_frequency: "撤单频率过高"
  };
  return labels[reason] ?? reason;
}

function DecisionDetail({ decision, onClose }: { decision: OrderRiskDecisionDto; onClose: () => void }) {
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="risk-decision-title">
      <h2 id="risk-decision-title">异常订单复核详情</h2>
      <dl className={styles.details}>
        <div><dt>决策 ID</dt><dd className={styles.mono}>{decision.id}</dd></div>
        <div><dt>结果</dt><dd>{outcomeLabel(decision.outcome)}</dd></div>
        <div><dt>动作</dt><dd>{actionLabel(decision.action)}</dd></div>
        <div><dt>风险评分</dt><dd>{decision.score}</dd></div>
        <div><dt>SKU</dt><dd className={styles.mono}>{decision.skuId}</dd></div>
        <div><dt>关联订单</dt><dd className={styles.mono}>{decision.orderId ?? "创建前拦截，未生成订单"}</dd></div>
        <div><dt>规则版本</dt><dd>{decision.ruleVersion}</dd></div>
        <div><dt>记录时间</dt><dd>{formatDate(decision.createdAt)}</dd></div>
      </dl>
      <section className={styles.logEntry} aria-label="关联日志入口">
        <h3>关联日志入口</h3>
        <p>使用风控决策 ID <code>{decision.id}</code> 在后续审计日志检索中关联该不可变决策。此页不返回用户身份、资产、资金冻结、请求体或任何放行操作。</p>
      </section>
      <div className="actions"><button className="button" type="button" onClick={onClose}>关闭</button></div>
    </section>
  </div>;
}

/** I21F 管理端只读复核：不提供放行、撤单、资产或规则配置写入。 */
export function OrderRiskAdminPage() {
  const [outcome, setOutcome] = useState<OrderRiskDecisionFilters["outcome"]>(undefined);
  const [selected, setSelected] = useState<OrderRiskDecisionDto | null>(null);
  const decisions = useOrderRiskDecisionsQuery({ outcome, limit: 20 });

  if (decisions.isPending) return <PageSkeleton label="正在加载异常订单" />;
  if (decisions.isError) return <main className="page"><ErrorState title={decisions.error instanceof ApiClientError && decisions.error.code === "AUTHORIZATION_DENIED" ? "无权查看异常订单" : "异常订单加载失败"} onRetry={() => void decisions.refetch()} /></main>;
  if (!decisions.data) return <PageSkeleton label="正在确认异常订单访问权限" />;
  const page = decisions.data.data;

  return <main className={`page ${styles.page}`}>
    <p className="eyebrow">本地管理 API · 只读复核</p>
    <h1>异常订单</h1>
    <p className="intro">此页只展示服务端已记录的风险决策。查看不会改变订单、余额、库存或保证金；页面没有放行、改资产或静默处理入口。</p>
    <label className={styles.filter}>结果筛选
      <select aria-label="风险结果筛选" value={outcome ?? ""} onChange={(event) => setOutcome((event.target.value || undefined) as OrderRiskDecisionFilters["outcome"])}>
        <option value="">已拦截与待复核</option><option value="blocked">仅已拦截</option><option value="flagged">仅待复核</option>
      </select>
    </label>
    {page.items.length === 0 ? <EmptyState title="没有异常订单">当前筛选下没有服务端标记的已拦截或待复核订单。</EmptyState> : <div className={styles.tableWrap}>
      <table><thead><tr><th>时间</th><th>结果</th><th>动作</th><th>原因</th><th>评分</th><th>规则版本</th><th>操作</th></tr></thead><tbody>
        {page.items.map((decision) => <tr key={decision.id}><td>{formatDate(decision.createdAt)}</td><td><span className={decision.outcome === "blocked" ? styles.blocked : styles.flagged}>{outcomeLabel(decision.outcome)}</span></td><td>{actionLabel(decision.action)}</td><td>{decision.reasons.map(reasonLabel).join("、")}</td><td>{decision.score}</td><td>{decision.ruleVersion}</td><td><button className="button secondary" type="button" onClick={() => setSelected(decision)}>查看详情</button></td></tr>)}
      </tbody></table>
    </div>}
    <p className={styles.privacy}>脱敏说明：不显示用户身份、账户余额、库存、资金/库存冻结、请求体或凭据；风控结论及资产状态均以服务端记录为准。</p>
    {selected ? <DecisionDetail decision={selected} onClose={() => setSelected(null)} /> : null}
  </main>;
}
