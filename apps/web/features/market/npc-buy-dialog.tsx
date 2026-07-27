"use client";

import type { MarketQuoteListItemDto, NpcBuyPreviewDto, NpcTradeDto } from "@mtg-market/contracts";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { useNpcBuyMutation, useNpcBuyPreviewQuery } from "../../api/npc-trade-api";
import { formatMoney } from "../../utils/money";
import styles from "./market-page.module.css";

function unavailableMessage(preview: NpcBuyPreviewDto): string | null {
  if (preview.unavailableReason === "archive_required") return "请先在玩家首页创建游戏存档。";
  if (preview.unavailableReason === "insufficient_balance") return "可用余额不足，无法按此服务端预览成交。";
  if (preview.unavailableReason === "trade_limit_reached") return "已达到服务端单笔或今日该卡交易额度。";
  return null;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function PreviewDetails({ preview }: { preview: NpcBuyPreviewDto }) {
  const unavailable = unavailableMessage(preview);
  return <section className={styles.tradePreview} aria-label="服务端买入预览">
    <h3>服务端买入预览</h3>
    <p>数量：{preview.quantity}</p>
    <p>单位成交价：{formatMoney(preview.unitPrice)}（其中费用 {formatMoney(preview.unitFee)}）</p>
    <p><strong>本次总扣款：{formatMoney(preview.total)}</strong>（其中费用 {formatMoney(preview.fee)}）</p>
    <p>报价有效至：{formatDate(preview.validUntil)}</p>
    <p>服务端额度：单笔最多 {preview.limit.maxQuantityPerTrade} 张；今日剩余 {preview.limit.remainingQuantityToday} / {preview.limit.maxQuantityPerUserSkuDay} 张。</p>
    {unavailable ? <p className={styles.tradeError}>{unavailable}</p> : <p className={styles.tradeReady}>可确认成交；最终余额与库存以服务端成交响应为准。</p>}
  </section>;
}

/** 数量、金额、额度与结算分层：用户只输入数量，随后读取并确认服务端不可变报价预览。 */
export function NpcBuyDialog({ item, onClose, onSettled }: { item: MarketQuoteListItemDto; onClose: () => void; onSettled: (trade: NpcTradeDto) => void }) {
  const [quantityText, setQuantityText] = useState("1");
  const [requestedQuantity, setRequestedQuantity] = useState(1);
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const preview = useNpcBuyPreviewQuery(item.sku.id, requestedQuantity, true);
  const buy = useNpcBuyMutation();
  const previewValue = preview.data?.data.preview;
  const mutationError = buy.error instanceof ApiClientError ? buy.error.message : buy.isError ? "成交请求未完成，请重新获取预览后再试。" : null;

  const requestPreview = (event: React.FormEvent) => {
    event.preventDefault();
    const quantity = Number(quantityText);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      setQuantityError("请输入 1 到 1000 之间的整数数量。");
      return;
    }
    setQuantityError(null);
    buy.beginNewIntent();
    setRequestedQuantity(quantity);
    // 数量相同也必须重新读取余额、额度及报价有效期。
    if (quantity === requestedQuantity) void preview.refetch();
  };
  const refreshPreview = () => {
    buy.beginNewIntent();
    void preview.refetch();
  };
  const confirm = () => {
    if (!previewValue?.canPurchase) return;
    buy.mutate({
      skuId: previewValue.skuId,
      quoteId: previewValue.quoteId,
      quoteVersion: previewValue.quoteVersion,
      quantity: previewValue.quantity,
      // 限价等于玩家刚确认的服务端单位价，不能用浏览器自行计算的总价或费用。
      maxUnitPrice: previewValue.unitPrice.amount
    }, { onSuccess: ({ data }) => onSettled(data.trade) });
  };
  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="npc-buy-title">
      <h2 id="npc-buy-title">向 NPC 买入</h2>
      <p><strong>{item.sku.name}</strong> · {item.sku.setCode} · #{item.sku.collectorNumber}</p>
      <form className={styles.quantityForm} onSubmit={requestPreview}>
        <label>买入数量
          <input aria-label="买入数量" type="number" min="1" max="1000" step="1" value={quantityText} disabled={buy.isPending} onChange={(event) => setQuantityText(event.target.value)} />
        </label>
        <button className="button secondary" type="submit" disabled={buy.isPending}>获取服务端预览</button>
      </form>
      {quantityError ? <p className={styles.tradeError} role="alert">{quantityError}</p> : null}
      {preview.isPending || preview.isFetching ? <p aria-busy="true">正在获取服务端买入预览…</p> : null}
      {preview.isError ? <section className={styles.inlineError} role="alert"><p>{preview.error instanceof ApiClientError ? preview.error.message : "买入预览加载失败。"}</p><button className="button secondary" type="button" onClick={refreshPreview}>重新预览</button></section> : null}
      {previewValue ? <PreviewDetails preview={previewValue} /> : null}
      {mutationError ? <p className={styles.tradeError} role="alert">{mutationError}</p> : null}
      <div className="actions">
        <button className="button secondary" type="button" disabled={buy.isPending} onClick={onClose}>取消</button>
        <button className="button" type="button" disabled={!previewValue?.canPurchase || preview.isFetching || buy.isPending} onClick={confirm}>{buy.isPending ? "正在由服务端成交…" : "确认向 NPC 买入"}</button>
      </div>
    </section>
  </div>;
}
