"use client";

import type { BatchNpcSellResultDto } from "@mtg-market/contracts";
import { useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import { useSellBatchMutation } from "../../api/npc-trade-api";
import { formatMoney } from "../../utils/money";
import styles from "./inventory-page.module.css";

const skipLabels: Record<string, string> = {
  not_held: "未持有该 SKU",
  no_available_quantity: "可用库存为 0（全部被订单/比赛锁定）",
  quote_unavailable: "暂无有效报价，未卖出",
  quote_stale: "报价快照已过期，未卖出",
  trade_limit_reached: "已到服务端今日交易额度，未卖出"
};

function skipLabel(reason: string): string {
  return skipLabels[reason] ?? "服务端跳过了该 SKU";
}

/**
 * I34F（I34B D4）：按筛选结果批量卖出。弹窗只提交当前筛选命中的 SKU 意图列表，
 * 逐 SKU 的张数/单价/费用与每日额度由服务端在单事务内结算（任一失败整批回滚）；
 * 与 C8 重复卡清仓不同，本入口不保留任何一张可用库存。
 */
export function BatchSellDialog({
  open,
  skuIds,
  onClose,
  onSettled
}: {
  open: boolean;
  skuIds: string[];
  onClose: () => void;
  onSettled: (result: BatchNpcSellResultDto) => void;
}) {
  const sell = useSellBatchMutation();
  const confirmationLock = useRef(false);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const mutationError =
    sell.error instanceof ApiClientError
      ? sell.error.message
      : sell.isError
        ? "批量卖出请求未完成，请使用相同按钮重试。"
        : null;

  const confirm = () => {
    if (confirmationLock.current || sell.isPending || skuIds.length === 0) return;
    confirmationLock.current = true;
    setConfirmationPending(true);
    sell.mutate(
      { skuIds },
      {
        onSuccess: ({ data }) => onSettled(data.result),
        onSettled: () => {
          setConfirmationPending(false);
        }
      }
    );
  };

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="batch-sell-title">
        <h2 id="batch-sell-title">批量卖出当前筛选</h2>
        <p>
          将把当前筛选命中的 <strong>{skuIds.length}</strong> 个 SKU 按服务端当前 NPC
          收购价全部卖出（<strong>不保留任何一张</strong>可用库存）。只提交卖出意图，实际张数、
          单价、费用与额度约束由服务端在单个事务内结算。
        </p>
        <p className={styles.secondary}>
          订单与比赛锁定的卡牌、无有效报价的卡牌及超出今日额度的卡牌会被跳过并汇总；
          任一项结算失败时整批回滚，不会留下半完成状态。
        </p>
        {mutationError ? (
          <section className={styles.inlineError} role="alert">
            <p>{mutationError}</p>
            <button
              className="button secondary"
              type="button"
              onClick={() => {
                sell.beginNewIntent();
                setConfirmationPending(false);
                confirmationLock.current = false;
              }}
            >
              重试
            </button>
          </section>
        ) : null}
        <div className="actions">
          <button className="button secondary" type="button" disabled={sell.isPending || confirmationPending} onClick={onClose}>
            取消
          </button>
          <button className="button" type="button" disabled={sell.isPending || confirmationPending || skuIds.length === 0} onClick={confirm}>
            {sell.isPending || confirmationPending ? "正在由服务端批量结算…" : "确认批量卖出"}
          </button>
        </div>
      </section>
    </div>
  );
}

/** I34F：按筛选批量卖出结果横幅；只展示服务端返回的张数/收入/费用与跳过明细，浏览器不统计。 */
export function BatchSellResultBanner({ result }: { result: BatchNpcSellResultDto }) {
  return (
    <section className={styles.tradeSuccess} role="status" aria-label="按筛选批量卖出结果">
      <h2>按筛选批量卖出已完成</h2>
      <p>
        服务端共卖出 <strong>{result.cardCount}</strong> 张（{result.soldItems.length} 个
        SKU），实际收入 {formatMoney(result.income)}（其中费用 {formatMoney(result.fee)}
        ）。余额、库存、报价与账本正在按服务器响应刷新。
      </p>
      {result.skippedItems.length > 0 ? (
        <ul className={styles.skipList}>
          {result.skippedItems.map((item) => (
            <li key={item.skuId}>{item.skuId}：{skipLabel(item.reason)}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
