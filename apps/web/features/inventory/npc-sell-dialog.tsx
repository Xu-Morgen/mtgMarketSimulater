"use client";

import type { InventoryHoldingDto, NpcSellPreviewDto, NpcTradeDto } from "@mtg-market/contracts";
import { useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import { useNpcSellMutation, useNpcSellPreviewQuery } from "../../api/npc-trade-api";
import { formatMoney } from "../../utils/money";
import styles from "./inventory-page.module.css";

function unavailableMessage(preview: NpcSellPreviewDto): string | null {
  if (preview.unavailableReason === "archive_required") return "请先在玩家首页创建游戏存档。";
  if (preview.unavailableReason === "insufficient_inventory") return "当前可用库存不足；订单和比赛锁定的卡牌不能出售。";
  if (preview.unavailableReason === "trade_limit_reached") return "已达到服务端单笔或今日该卡交易额度。";
  return null;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function PreviewDetails({ preview }: { preview: NpcSellPreviewDto }) {
  const unavailable = unavailableMessage(preview);
  return <section className={styles.tradePreview} aria-label="服务端卖出预览">
    <h3>服务端卖出预览</h3>
    <p>本次出售：{preview.quantity} 张（当前可用 {preview.availableQuantity} 张）</p>
    <p>NPC 收购单价：{formatMoney(preview.unitPrice)}（其中费用 {formatMoney(preview.unitFee)}）</p>
    <p><strong>本次预计收入：{formatMoney(preview.total)}</strong>（其中费用 {formatMoney(preview.fee)}）</p>
    <p>报价有效至：{formatDate(preview.validUntil)}</p>
    <p>服务端额度：单笔最多 {preview.limit.maxQuantityPerTrade} 张；今日剩余 {preview.limit.remainingQuantityToday} / {preview.limit.maxQuantityPerUserSkuDay} 张。</p>
    {unavailable ? <p className={styles.tradeError}>{unavailable}</p> : <p className={styles.tradeReady}>可确认成交；最终余额、库存和收入以服务端成交响应为准。</p>}
  </section>;
}

/** 卖出只提交数量意图或 `all`；可用量、锁定量、价格、费用与成交均由服务端处理。 */
export function NpcSellDialog({ holding, onClose, onSettled, onboardingGuarantee = false }: { holding: InventoryHoldingDto; onClose: () => void; onSettled: (trade: NpcTradeDto) => void; onboardingGuarantee?: boolean }) {
  const [quantityText, setQuantityText] = useState("1");
  const [requestedQuantity, setRequestedQuantity] = useState<number | "all">(1);
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const confirmationLock = useRef(false);
  const preview = useNpcSellPreviewQuery(holding.skuId, requestedQuantity, true);
  const sell = useNpcSellMutation();
  const previewValue = preview.data?.data.preview;
  const mutationError = sell.error instanceof ApiClientError ? sell.error.message : sell.isError ? "成交请求未完成，请重新获取预览后再试。" : null;

  const requestPreview = (event: React.FormEvent) => {
    event.preventDefault();
    const quantity = Number(quantityText);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      setQuantityError("请输入 1 到 1000 之间的整数数量，或选择全部可用库存。");
      return;
    }
    setQuantityError(null);
    confirmationLock.current = false;
    setConfirmationPending(false);
    sell.beginNewIntent();
    setRequestedQuantity(quantity);
    if (quantity === requestedQuantity) void preview.refetch();
  };
  const requestAllPreview = () => {
    setQuantityError(null);
    confirmationLock.current = false;
    setConfirmationPending(false);
    sell.beginNewIntent();
    setRequestedQuantity("all");
    if (requestedQuantity === "all") void preview.refetch();
  };
  const refreshPreview = () => {
    confirmationLock.current = false;
    setConfirmationPending(false);
    sell.beginNewIntent();
    void preview.refetch();
  };
  const confirm = () => {
    // React 的 disabled 渲染不是同步锁；此 ref 阻止同一事件循环中的双击发出第二个 HTTP 请求。
    if (confirmationLock.current || !previewValue?.canSell) return;
    confirmationLock.current = true;
    setConfirmationPending(true);
    sell.mutate({
      skuId: previewValue.skuId,
      quoteId: previewValue.quoteId,
      quoteVersion: previewValue.quoteVersion,
      quantity: previewValue.quantity,
      // 最低价正好是玩家刚确认的服务端收购单价，页面不会生成或比较总价。
      minUnitPrice: previewValue.unitPrice.amount
    }, { onSuccess: ({ data }) => onSettled(data.trade) });
  };

  return <div className="dialog-backdrop" role="presentation">
    <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="npc-sell-title">
      <h2 id="npc-sell-title">向 NPC 卖出</h2>
      <p><strong>{holding.sku.name}</strong> · {holding.sku.setCode} · #{holding.sku.collectorNumber}</p>
      <p className={styles.secondary}>当前持有 {holding.quantity} 张；可用 {holding.availableQuantity} 张；订单锁定 {holding.orderLockedQuantity} 张；比赛锁定 {holding.tournamentLockedQuantity} 张。</p>
      <form className={styles.quantityForm} onSubmit={requestPreview}>
        <label>卖出数量
          <input aria-label="卖出数量" type="number" min="1" max={onboardingGuarantee ? 1 : 1000} step="1" value={quantityText} disabled={sell.isPending || onboardingGuarantee} onChange={(event) => setQuantityText(event.target.value)} />
        </label>
        <button id={!previewValue?.canSell || preview.isFetching ? "onboarding-npc-sell-preview" : undefined} className="button secondary" type="submit" disabled={sell.isPending || confirmationPending}>获取服务端预览</button>
        {onboardingGuarantee ? <span className={styles.secondary}>新手保底机会固定交易 1 张</span> : <button className="button secondary" type="button" disabled={sell.isPending || confirmationPending} onClick={requestAllPreview}>全部可用库存</button>}
      </form>
      {quantityError ? <p className={styles.tradeError} role="alert">{quantityError}</p> : null}
      {preview.isPending || preview.isFetching ? <p aria-busy="true">正在获取服务端卖出预览…</p> : null}
      {preview.isError ? <section className={styles.inlineError} role="alert"><p>{preview.error instanceof ApiClientError ? preview.error.message : "卖出预览加载失败。"}</p><button className="button secondary" type="button" onClick={refreshPreview}>重新预览</button></section> : null}
      {previewValue ? <PreviewDetails preview={previewValue} /> : null}
      {mutationError ? <section className={styles.inlineError} role="alert"><p>{mutationError}</p><button className="button secondary" type="button" onClick={refreshPreview}>重新预览</button></section> : null}
      <div className="actions">
        <button className="button secondary" type="button" disabled={sell.isPending || confirmationPending} onClick={onClose}>取消</button>
        <button id={previewValue?.canSell && !preview.isFetching ? "onboarding-npc-sell-confirm" : undefined} className="button" type="button" disabled={!previewValue?.canSell || preview.isFetching || sell.isPending || confirmationPending} onClick={confirm}>{sell.isPending || confirmationPending ? "正在由服务端成交…" : "确认向 NPC 卖出"}</button>
      </div>
    </section>
  </div>;
}
