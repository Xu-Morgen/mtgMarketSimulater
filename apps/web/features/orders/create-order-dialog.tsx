"use client";

import type { BilateralOrderDto, BilateralOrderPreviewDto, OrderSide } from "@mtg-market/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import { useCreateOrderMutation, useOrderPreviewQuery } from "../../api/orders-api";
import { formatMoney } from "../../utils/money";
import styles from "./orders-page.module.css";

export interface OrderSkuSummary {
  id: string;
  name: string;
  setCode: string;
  collectorNumber: string;
}

function unavailableMessage(preview: BilateralOrderPreviewDto): string | null {
  if (preview.unavailableReason === "archive_required") return "请先在玩家首页创建游戏存档。";
  if (preview.unavailableReason === "insufficient_balance") return "当前余额不足以预占买单资金，请减少数量或补充游戏币。";
  if (preview.unavailableReason === "insufficient_inventory") return "当前可用库存不足；订单和比赛锁定的卡牌不能挂卖单。";
  if (preview.unavailableReason === "trade_limit_reached") return "已达到服务端单笔或今日该卡交易额度。";
  return null;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function feeAmount(preview: BilateralOrderPreviewDto, kind: "order_fee" | "fulfillment_deposit"): number {
  return preview.fees.find((fee) => fee.kind === kind)?.amount.amount ?? 0;
}

function limitWithinBand(preview: BilateralOrderPreviewDto, limitPrice: number): boolean {
  return Number.isInteger(limitPrice) && limitPrice >= preview.limitBand.min.amount && limitPrice <= preview.limitBand.max.amount;
}

/** 风控由服务端裁决；这里仅将稳定的拒绝理由转换为玩家可执行的下一步。 */
function riskRejectionHint(error: ApiClientError | null): string | null {
  if (!error || error.code !== "RULE_VIOLATION" || !error.message.startsWith("订单风控已拦截：")) return null;
  if (error.message.includes("下单冷却中")) return "风控拒绝：下单冷却尚未结束。请稍后重新获取服务端预览；不要反复提交同一请求。";
  if (error.message.includes("下单频率过高")) return "风控拒绝：短时间内下单次数过多。请等待后重新获取服务端预览。";
  if (error.message.includes("交易数量超限")) return "风控拒绝：数量超过服务端单笔或当日额度。请按下方“服务端额度”减少数量后重新预览。";
  if (error.message.includes("检测到可能自买自卖")) return "风控拒绝：该限价可能与自己的反向委托成交。请撤销或调整自己的反向委托后重新预览。";
  if (error.message.includes("限价越界")) return "风控拒绝：限价不在服务端允许范围。请使用当前服务端限价带重新预览后提交。";
  return "风控拒绝：当前委托不符合服务器规则。请重新获取服务端预览并按显示的限价带与额度调整。";
}

function PreviewDetails({ preview, side, limitPrice, limitError }: { preview: BilateralOrderPreviewDto; side: OrderSide; limitPrice: number; limitError: string | null }) {
  const orderFee = feeAmount(preview, "order_fee");
  const fulfillmentDeposit = feeAmount(preview, "fulfillment_deposit");
  const unavailable = unavailableMessage(preview);
  return <section className={styles.tradePreview} aria-label="服务端挂单预览">
    <h3>服务端挂单预览</h3>
    <p>方向：{side === "buy" ? "买单" : "卖单"} · 数量：{preview.quantity}{side === "sell" && preview.availableQuantity !== undefined ? `（当前可用 ${preview.availableQuantity} 张）` : ""}</p>
    <p>限价带：{formatMoney(preview.limitBand.min)} – {formatMoney(preview.limitBand.max)}（服务端锚点 {formatMoney(preview.limitBand.marketPrice)}，带宽 {preview.limitBand.limitPriceBandBasisPoints} bp）</p>
    <p>当前限价：{Number.isInteger(limitPrice) ? formatMoney({ amount: limitPrice, currency: "GAME_CREDIT" }) : "—"}</p>
    {limitError ? <p className={styles.tradeError} role="alert">{limitError}</p> : null}
    <p>预计{side === "buy" ? "支出" : "到手（未扣履约时 order_fee）"}：<strong>{formatMoney(preview.estimatedAmount)}</strong></p>
    <p>服务端费用拆分：order_fee {formatMoney({ amount: orderFee, currency: "GAME_CREDIT" })}；fulfillment_deposit {formatMoney({ amount: fulfillmentDeposit, currency: "GAME_CREDIT" })}。</p>
    <p>本次预占：{side === "buy" ? `买单资金 ${formatMoney(preview.reservedFunds)}（数量×限价 + order_fee）` : `履约保证金 ${formatMoney(preview.reservedFunds)}（库存按服务端锁定，order_fee 在 I19B 撮合时确认、I20B 履约时从卖方收入扣除）`}。</p>
    <p>报价有效至：{formatDate(preview.validUntil)}（委托有效期 {preview.limit.ttlSeconds / 3600} 小时）。</p>
    <p>服务端额度：单笔最多 {preview.limit.maxQuantityPerOrder} 张；今日剩余 {preview.limit.remainingQuantityToday} / {preview.limit.maxQuantityPerUserSkuDay} 张。</p>
    <p className={styles.secondary}>挂单成功后服务端会自动撮合（I19B 已上线），委托可能经部分成交推进到待履约；模拟履约与到期回收在 I20B/I22B 上线。</p>
    {unavailable ? <p className={styles.tradeError}>{unavailable}</p> : <p className={styles.tradeReady}>可确认挂单；最终余额、库存、保证金与委托状态以服务端创建响应为准。</p>}
  </section>;
}

/** 挂单只提交方向、数量与限价；报价标识、规则/预览版本原样回传，费用/保证金/限价带均不回传或重算。 */
export function CreateOrderDialog({ sku, initialSide, onClose, onSettled }: { sku: OrderSkuSummary; initialSide: OrderSide; onClose: () => void; onSettled: (order: BilateralOrderDto) => void }) {
  const [side, setSide] = useState<OrderSide>(initialSide);
  const [quantityText, setQuantityText] = useState("1");
  const [requestedQuantity, setRequestedQuantity] = useState(1);
  const [requestedSide, setRequestedSide] = useState<OrderSide>(initialSide);
  const [quantityError, setQuantityError] = useState<string | null>(null);
  const [limitText, setLimitText] = useState("");
  const [limitError, setLimitError] = useState<string | null>(null);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const confirmationLock = useRef(false);
  const preview = useOrderPreviewQuery(sku.id, requestedSide, requestedQuantity, true);
  const create = useCreateOrderMutation(requestedSide);
  const previewValue = preview.data?.data.preview;

  // 切换方向或拿到新预览时，把限价默认到服务端锚点（中间价），并由玩家在限价带内调整。
  const marketPriceAmount = previewValue?.limitBand.marketPrice.amount;
  const previewVersion = previewValue?.previewVersion;
  useEffect(() => {
    if (previewValue) setLimitText(String(previewValue.limitBand.marketPrice.amount));
  }, [previewValue, marketPriceAmount, previewVersion]);

  const limitPrice = useMemo(() => Number(limitText), [limitText]);
  const limitValid = previewValue ? limitWithinBand(previewValue, limitPrice) : false;
  const apiMutationError = create.error instanceof ApiClientError ? create.error : null;
  const mutationError = apiMutationError ? apiMutationError.message : create.isError ? "挂单请求未完成，请重新获取预览后再试。" : null;
  const riskHint = riskRejectionHint(apiMutationError);
  const staleFromMutation = create.error instanceof ApiClientError && create.error.code === "VERSION_STALE";

  const resetConfirmation = () => {
    confirmationLock.current = false;
    setConfirmationPending(false);
    create.beginNewIntent();
  };
  const requestPreview = (nextSide: OrderSide, nextQuantity: number) => {
    setQuantityError(null);
    setLimitError(null);
    resetConfirmation();
    setRequestedSide(nextSide);
    setRequestedQuantity(nextQuantity);
    if (nextSide === requestedSide && nextQuantity === requestedQuantity) void preview.refetch();
  };
  const submitQuantity = (event: React.FormEvent) => {
    event.preventDefault();
    const quantity = Number(quantityText);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      setQuantityError("请输入 1 到 1000 之间的整数数量。");
      return;
    }
    requestPreview(side, quantity);
  };
  const switchSide = (nextSide: OrderSide) => {
    if (nextSide === side) return;
    setSide(nextSide);
    const quantity = Number(quantityText);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1000) {
      setQuantityError("请输入 1 到 1000 之间的整数数量。");
      return;
    }
    requestPreview(nextSide, quantity);
  };
  const refreshPreview = () => { resetConfirmation(); void preview.refetch(); };
  const validateLimit = (): boolean => {
    if (!previewValue) return false;
    if (!Number.isInteger(limitPrice)) { setLimitError("限价必须是整数最小货币单位（游戏币）。"); return false; }
    if (!limitWithinBand(previewValue, limitPrice)) {
      setLimitError(`限价必须在服务端限价带 ${formatMoney(previewValue.limitBand.min)} 至 ${formatMoney(previewValue.limitBand.max)} 之间；越界由服务端以 RULE_VIOLATION 拒绝。`);
      return false;
    }
    setLimitError(null);
    return true;
  };
  const confirm = () => {
    // React 的 disabled 渲染不是同步锁；此 ref 阻止同一事件循环中的双击发出第二个 HTTP 请求。
    if (confirmationLock.current || !previewValue?.canPlace || !validateLimit()) return;
    confirmationLock.current = true;
    setConfirmationPending(true);
    create.mutate(
      {
        skuId: previewValue.skuId,
        quoteId: previewValue.quoteId,
        quoteVersion: previewValue.quoteVersion,
        previewVersion: previewValue.previewVersion,
        quantity: previewValue.quantity,
        limitPrice
      },
      { onSuccess: ({ data }) => onSettled(data.order) }
    );
  };
  const confirmDisabled = !previewValue?.canPlace || !limitValid || preview.isFetching || create.isPending || confirmationPending;
  const sideButtons: Array<{ value: OrderSide; label: string }> = [{ value: "buy", label: "买单" }, { value: "sell", label: "卖单" }];

  return <div className="dialog-backdrop" role="presentation">
    <section className={`dialog ${styles.orderDialog}`} role="dialog" aria-modal="true" aria-labelledby="create-order-title">
      <h2 id="create-order-title">挂委托</h2>
      <p><strong>{sku.name}</strong> · {sku.setCode} · #{sku.collectorNumber}</p>
      <div className={styles.sideSwitch} role="group" aria-label="委托方向">
        {sideButtons.map((option) => <button key={option.value} type="button" className={`button ${side === option.value ? "" : "secondary"}`} disabled={create.isPending || confirmationPending} aria-pressed={side === option.value} onClick={() => switchSide(option.value)}>{option.label}</button>)}
      </div>
      <form className={styles.quantityForm} onSubmit={submitQuantity}>
        <label>数量
          <input aria-label="委托数量" type="number" min="1" max="1000" step="1" value={quantityText} disabled={create.isPending || confirmationPending} onChange={(event) => setQuantityText(event.target.value)} />
        </label>
        <button className="button secondary" type="submit" disabled={create.isPending || confirmationPending}>获取服务端预览</button>
      </form>
      {quantityError ? <p className={styles.tradeError} role="alert">{quantityError}</p> : null}
      {preview.isPending || preview.isFetching ? <p aria-busy="true">正在获取服务端挂单预览…</p> : null}
      {preview.isError ? <section className={styles.inlineError} role="alert"><p>{preview.error instanceof ApiClientError ? preview.error.message : "挂单预览加载失败。"}</p><button className="button secondary" type="button" onClick={refreshPreview}>重新预览</button></section> : null}
      {previewValue ? <>
        <PreviewDetails preview={previewValue} side={requestedSide} limitPrice={limitPrice} limitError={limitError} />
        <label className={styles.limitField}>限价（游戏币，整数最小货币单位）
          <input aria-label="委托限价" type="number" min={previewValue.limitBand.min.amount} max={previewValue.limitBand.max.amount} step="1" value={limitText} disabled={create.isPending || confirmationPending} onBlur={validateLimit} onChange={(event) => { setLimitText(event.target.value); if (limitError) setLimitError(null); }} />
          <small className={styles.secondary}>限价必须在限价带 {formatMoney(previewValue.limitBand.min)} 至 {formatMoney(previewValue.limitBand.max)} 之间；最终边界由服务端按 order/v1 校验。</small>
        </label>
      </> : null}
      {mutationError ? <section className={styles.inlineError} role="alert"><p>{mutationError}</p>{riskHint ? <p>{riskHint}</p> : null}{staleFromMutation ? <p className={styles.secondary}>报价或预览已过期，请重新获取服务端预览后再确认。</p> : null}<button className="button secondary" type="button" onClick={refreshPreview}>重新预览</button></section> : null}
      <div className="actions">
        <button className="button secondary" type="button" disabled={create.isPending || confirmationPending} onClick={onClose}>取消</button>
        <button className="button" type="button" disabled={confirmDisabled} onClick={confirm}>{create.isPending || confirmationPending ? "正在由服务端创建…" : `确认挂${requestedSide === "buy" ? "买单" : "卖单"}`}</button>
      </div>
    </section>
  </div>;
}
