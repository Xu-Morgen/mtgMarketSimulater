"use client";

import type { DuplicatesSellResultDto } from "@mtg-market/contracts";
import { useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import { useSellDuplicatesMutation } from "../../api/npc-trade-api";
import { formatMoney } from "../../utils/money";
import styles from "./inventory-page.module.css";

const skipLabels: Record<string, string> = {
  no_duplicate: "仅持有 1 张，无重复可卖",
  locked: "该卡存在订单或比赛锁定，未卖出",
  quote_unavailable: "暂无有效报价，未卖出",
  quote_stale: "报价快照已过期，未卖出",
  trade_limit_reached: "已到服务端今日交易额度，未卖出"
};

/**
 * I33F（I33B C8）：重复卡一键清仓。只提交意图；逐 SKU 的张数/价格/费用与额度由服务端在
 * 单事务内结算，弹窗只展示服务端预览前说明与结算后的汇总横幅，浏览器不统计或估值。
 */
export function DuplicatesSellDialog({
  open,
  onClose,
  onSettled
}: {
  open: boolean;
  onClose: () => void;
  onSettled: (result: DuplicatesSellResultDto) => void;
}) {
  const sell = useSellDuplicatesMutation();
  const confirmationLock = useRef(false);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const mutationError =
    sell.error instanceof ApiClientError
      ? sell.error.message
      : sell.isError
        ? "批量卖出请求未完成，请使用相同按钮重试。"
        : null;

  const confirm = () => {
    if (confirmationLock.current || sell.isPending) return;
    confirmationLock.current = true;
    setConfirmationPending(true);
    sell.mutate(undefined, {
      onSuccess: ({ data }) => onSettled(data.result),
      onSettled: () => {
        setConfirmationPending(false);
      }
    });
  };

  if (!open) return null;
  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="duplicates-sell-title"
      >
        <h2 id="duplicates-sell-title">批量卖出重复卡</h2>
        <p>
          将把“持有数量大于 1”的重复卡按服务端当前 NPC 收购价全部卖出（每个 SKU 至少保留 1
          张）。只提交卖出意图，实际张数、单价、费用与额度约束由服务端在单个事务内结算。
        </p>
        <p className={styles.secondary}>
          订单与比赛锁定的卡牌、无有效报价的卡牌及超出今日额度的卡牌会被跳过，不会报错。
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
          <button
            className="button secondary"
            type="button"
            disabled={sell.isPending || confirmationPending}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button"
            type="button"
            disabled={sell.isPending || confirmationPending}
            onClick={confirm}
          >
            {sell.isPending || confirmationPending ? "正在由服务端批量结算…" : "确认批量卖出重复卡"}
          </button>
        </div>
      </section>
    </div>
  );
}

function skipLabel(reason: string): string {
  return skipLabels[reason] ?? "服务端跳过了该卡牌";
}

/** I33F：批量卖出结果横幅；只展示服务端返回的张数/收入/费用汇总，浏览器不统计。 */
export function DuplicatesSellResultBanner({ result }: { result: DuplicatesSellResultDto }) {
  return (
    <section className={styles.tradeSuccess} role="status" aria-label="重复卡批量卖出结果">
      <h2>重复卡批量卖出已完成</h2>
      <p>
        服务端共卖出 <strong>{result.cardCount}</strong> 张（{result.soldItems.length} 个
        SKU），实际收入 {formatMoney(result.income)}（其中费用 {formatMoney(result.fee)}
        ）。余额、库存与收藏图鉴正在按服务器响应刷新。
      </p>
      {result.skippedItems.length > 0 ? (
        <ul className={styles.skipList}>
          {result.skippedItems.map((item) => (
            <li key={item.skuId}>
              跳过 {item.skuId}：{skipLabel(item.reason)}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
