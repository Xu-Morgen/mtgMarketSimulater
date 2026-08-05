"use client";

import { Descriptions, Tag } from "antd";
import type { BulkPackOpeningDto, DuplicatesSellResultDto, PackDto, PackOpeningCardDto, PackOpeningDto, PackPurchasePreviewDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  useOpenBulkPackMutation,
  useOpenPackMutation,
  usePackDetailQuery,
  usePackOpeningsQuery,
  usePackPurchasePreviewQuery,
  usePacksQuery
} from "../../api/packs-api";
import { useCatalogDetailQuery } from "../../api/catalog-api";
import { useMarketQuoteQuery } from "../../api/market-api";
import { ApiClientError } from "../../api/client";
import { CatalogCardDetailModal } from "../../components/catalog-card-detail-modal";
import { LocalCatalogImage } from "../../components/local-catalog-image";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import { formatBasisPoints } from "../../utils/percent";
import { usePackOpeningAnimationStore } from "../../stores/pack-opening-animation-store";
import { DuplicatesSellDialog, DuplicatesSellResultBanner } from "../inventory/duplicates-sell-dialog";
import { offerCountdownText, offerDiscountPercent, offerUnavailableReason } from "./offer-display";
import { PackProbabilityTable } from "./pack-probability-table";
import styles from "./packs-page.module.css";

/** I33F：限时/特殊包折扣与窗口提示（购买资格仍以服务端 preview 与 offer.status 为准）。 */
function OfferBadge({ pack }: { pack: PackDto }) {
  const offer = pack.offer;
  if (!offer) return null;
  const discount = offerDiscountPercent(offer);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className={styles.offerBadge} role="status">
      <span className={styles.offerChip}>{discount ? `${discount} 限时折扣` : "限时销售"}</span>
      <span className={styles.offerCountdown}>{offerCountdownText(offer, now)}</span>
      {offer.description ? <span className={styles.offerDescription}>{offer.description}</span> : null}
    </div>
  );
}

/** 该包当前是否可发起购买意图：包已启用且限时窗口（若存在）处于 active。 */
function packPurchasable(pack: PackDto): boolean {
  if (!pack.enabled) return false;
  return pack.offer ? pack.offer.status === "active" : true;
}

function PackStatus({ pack }: { pack: PackDto }) {
  if (!pack.enabled)
    return (
      <p className={styles.disabled}>
        <strong>当前不可购买：</strong>
        {pack.disabledReason ?? "该补充包暂未启用。"}
      </p>
    );
  const offerReason = offerUnavailableReason(pack.offer);
  if (offerReason)
    return (
      <p className={styles.disabled}>
        <strong>当前不可购买：</strong>
        {offerReason}
      </p>
    );
  return <p className={styles.enabled}>已启用，可先查看服务端购买预览再确认开包。</p>;
}

function PurchasePreview({ preview }: { preview: PackPurchasePreviewDto }) {
  const unavailable =
    preview.unavailableReason === "insufficient_balance"
      ? "可用余额不足，请先获得更多游戏币。"
      : preview.unavailableReason === "archive_required"
        ? "请先在玩家首页创建游戏存档。"
        : null;
  return (
    <div className={styles.preview}>
      <h2>确认购买</h2>
      <p>
        <strong>{preview.pack.name}</strong>
      </p>
      <p>本次扣款：{formatMoney(preview.cost)}</p>
      {preview.pack.offer?.status === "active" ? (
        <p className={styles.metadata}>
          限时折扣价（窗口价 = 原价 × 服务端折扣率，整数向下取整）。
        </p>
      ) : null}
      <p>规则版本：{preview.ruleVersion}</p>
      {unavailable ? <p className={styles.purchaseError}>{unavailable}</p> : null}
      <p className={styles.metadata}>开奖结果、扣款和库存变更均由服务端一次性结算。</p>
    </div>
  );
}

function PurchaseDialog({
  pack,
  onClose,
  onOpened
}: {
  pack: PackDto;
  onClose: () => void;
  onOpened: (opening: PackOpeningDto) => void;
}) {
  const preview = usePackPurchasePreviewQuery(pack.id, true);
  const open = useOpenPackMutation();
  const confirmationLock = useRef(false);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const error =
    open.error instanceof ApiClientError
      ? open.error.message
      : open.isError
        ? "开包请求未完成，请使用相同按钮重试。"
        : null;
  const confirm = () => {
    const value = preview.data?.data.preview;
    if (!value?.canPurchase || confirmationLock.current) return;
    confirmationLock.current = true;
    setConfirmationPending(true);
    open.mutate(
      { packId: value.pack.id, ruleVersion: value.ruleVersion },
      {
        onSuccess: ({ data }) => onOpened(data.opening),
        onSettled: () => setConfirmationPending(false)
      }
    );
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="purchase-title">
        <h2 id="purchase-title">购买补充包</h2>
        {preview.isPending ? <p aria-busy="true">正在获取服务端购买预览…</p> : null}
        {preview.isError ? (
          <section className={styles.inlineError} role="alert">
            <p>
              {preview.error instanceof ApiClientError
                ? preview.error.message
                : "购买预览加载失败。"}
            </p>
            <button
              className="button secondary"
              type="button"
              onClick={() => void preview.refetch()}
            >
              重试预览
            </button>
          </section>
        ) : null}
        {preview.data ? <PurchasePreview preview={preview.data.data.preview} /> : null}
        {error ? (
          <p className={styles.purchaseError} role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button
            className="button secondary"
            type="button"
            disabled={open.isPending || confirmationPending}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button"
            type="button"
            disabled={
              preview.isPending ||
              preview.isError ||
              !preview.data?.data.preview.canPurchase ||
              open.isPending ||
              confirmationPending
            }
            onClick={confirm}
          >
            {open.isPending || confirmationPending ? "正在由服务端开包…" : "确认购买并开包"}
          </button>
        </div>
      </section>
    </div>
  );
}

const bulkCounts = [10, 50, 100] as const;

/**
 * I33F（I33B C7）批量开包：数量选择 + 二次确认。同一 `(packId, ruleVersion, count)`
 * 网络重试复用幂等键；成功后整包汇总交给页面展示，逐包下钻只读服务端结果。
 */
function BulkPurchaseDialog({
  pack,
  onClose,
  onOpened
}: {
  pack: PackDto;
  onClose: () => void;
  onOpened: (bulk: BulkPackOpeningDto) => void;
}) {
  const [count, setCount] = useState<(typeof bulkCounts)[number]>(10);
  const preview = usePackPurchasePreviewQuery(pack.id, true);
  const openBulk = useOpenBulkPackMutation();
  const confirmationLock = useRef(false);
  const [confirmationPending, setConfirmationPending] = useState(false);
  const unitCost = preview.data?.data.preview.cost.amount;
  const error =
    openBulk.error instanceof ApiClientError
      ? openBulk.error.message
      : openBulk.isError
        ? "批量开包请求未完成，请使用相同按钮重试。"
        : null;
  const confirm = () => {
    const value = preview.data?.data.preview;
    if (!value?.canPurchase || confirmationLock.current) return;
    confirmationLock.current = true;
    setConfirmationPending(true);
    openBulk.mutate(
      { packId: value.pack.id, ruleVersion: value.ruleVersion, count },
      {
        onSuccess: ({ data }) => onOpened(data.bulk),
        onSettled: () => setConfirmationPending(false)
      }
    );
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-title">
        <h2 id="bulk-title">批量开包</h2>
        <p>
          <strong>{pack.name}</strong>
        </p>
        {preview.isPending ? <p aria-busy="true">正在获取服务端购买预览…</p> : null}
        {preview.isError ? (
          <section className={styles.inlineError} role="alert">
            <p>
              {preview.error instanceof ApiClientError
                ? preview.error.message
                : "购买预览加载失败。"}
            </p>
            <button
              className="button secondary"
              type="button"
              onClick={() => void preview.refetch()}
            >
              重试预览
            </button>
          </section>
        ) : null}
        {preview.data ? (
          <div className={styles.bulkPreview}>
            <p>本次扣款（每包）：{formatMoney(preview.data.data.preview.cost)}</p>
            <p>规则版本：{preview.data.data.preview.ruleVersion}</p>
            <p className={styles.metadata}>批量开包在单个服务端事务内逐包结算；任一包失败整批回滚。</p>
          </div>
        ) : null}
        <fieldset className={styles.countFieldset}>
          <legend>包数</legend>
          {bulkCounts.map((value) => (
            <label key={value} className={styles.countOption}>
              <input
                type="radio"
                name="bulk-count"
                value={value}
                checked={count === value}
                onChange={() => setCount(value)}
                disabled={openBulk.isPending}
              />
              {value} 包
              {unitCost !== undefined ? <span className={styles.countCost}>≈ {formatMoney({ amount: unitCost * value, currency: "GAME_CREDIT" })}</span> : null}
            </label>
          ))}
        </fieldset>
        {error ? (
          <p className={styles.purchaseError} role="alert">
            {error}
          </p>
        ) : null}
        <div className="actions">
          <button
            className="button secondary"
            type="button"
            disabled={openBulk.isPending || confirmationPending}
            onClick={onClose}
          >
            取消
          </button>
          <button
            className="button"
            type="button"
            disabled={
              preview.isPending ||
              preview.isError ||
              !preview.data?.data.preview.canPurchase ||
              openBulk.isPending ||
              confirmationPending
            }
            onClick={confirm}
          >
            {openBulk.isPending || confirmationPending ? "正在由服务端批量开包…" : "确认批量开包"}
          </button>
        </div>
      </section>
    </div>
  );
}

/**
 * 开包记录只保存已结算事实；名称、罕贵度、卡图与“当前市场价”均实时读取本地只读投影。
 * I33F 增强：稀有度辉光（本地目录 rarity 驱动）、新卡/重复徽标与所在系列进度均来自服务端
 * 开包结果 DTO；动画状态丢失时立即显示已结算的服务端结果。
 */
function OpeningCardPresentation({ card, className }: { card: PackOpeningCardDto; className?: string | undefined }) {
  const catalog = useCatalogDetailQuery(card.skuId);
  const quote = useMarketQuoteQuery(card.skuId);
  const [selectedSkuId, setSelectedSkuId] = useState<string | null>(null);
  const name = catalog.data?.data.sku.name;
  const rarity = catalog.data?.data.sku.rarity;
  const isNew =
    typeof card.isNewToCollection === "boolean"
      ? card.isNewToCollection
      : null;
  const progress = card.collectionProgressAfter;
  const historyHref = `/market/history?skuId=${encodeURIComponent(card.skuId)}`;
  return (
    <div className={className ?? styles.openingCardContent}>
      <div className={styles.openingCardHeader}>
        <Link className={styles.openingNameLink} href={historyHref}>{catalog.isPending ? "正在加载卡牌名称…" : name ?? "卡牌资料暂不可用"}</Link>
        <button className="text-button" type="button" onClick={() => setSelectedSkuId(card.skuId)}>
          详情
        </button>
      </div>
      <div className={styles.openingArt}>
        <LocalCatalogImage
          path={catalog.data?.data.sku.image.path ?? null}
          name={name ?? "卡牌"}
          rarity={rarity}
        />
      </div>
      {isNew !== null ? (
        <span className={`${styles.collectionBadge} ${isNew ? styles.collectionNew : styles.collectionDuplicate}`}>
          {isNew ? "新卡" : "重复"}
        </span>
      ) : null}
      {catalog.isError ? <span className={styles.metadata}>卡牌名称暂不可用。</span> : null}
      <span>数量：{card.quantity}</span>
      <span>本次分摊成本：{formatMoney(card.cost)}</span>
      <span>当前市场价：{quote.isPending ? "正在加载…" : quote.data ? <Link className={styles.openingNameLink} href={historyHref}>{formatMoney(quote.data.data.quote.marketPrice)}</Link> : "暂无有效市场报价"}</span>
      {progress && progress.totalSkuCount > 0 ? (
        <span className={styles.metadata}>
          系列 {progress.setCode} 进度 {formatBasisPoints(progress.completionBasisPoints)}（已收集 {progress.collectedSkuCount} / {progress.totalSkuCount}）
        </span>
      ) : null}
      <CatalogCardDetailModal skuId={selectedSkuId} onClose={() => setSelectedSkuId(null)} />
    </div>
  );
}

/** I33F：本包成本与价值对比（盈亏红绿）。差额由服务端 `profitLoss.gameProfitLoss` 给出。 */
function CostValueComparison({ opening }: { opening: PackOpeningDto }) {
  if (opening.totalGameValue === null) {
    return (
      <p className={styles.metadata}>
        本包成本 {formatMoney(opening.totalCost)}；服务端暂无有效报价，本包估值暂不可用。
      </p>
    );
  }
  const diff = opening.profitLoss.gameProfitLoss; // 服务端可能给出估值但暂无盈亏差额
  if (diff === null || diff === undefined) {
    return (
      <p className={styles.metadata}>
        本包成本 {formatMoney(opening.totalCost)}；服务端当前估值 {formatMoney(opening.totalGameValue)}。
      </p>
    );
  }
  const delta = diff.amount;
  const label = delta > 0 ? "较成本上涨" : delta < 0 ? "较成本下跌" : "与成本持平";
  const className = delta > 0 ? styles.profit : delta < 0 ? styles.loss : styles.neutral;
  return (
    <p className={styles.metadata}>
      本包成本 {formatMoney(opening.totalCost)}；服务端当前估值 {formatMoney(opening.totalGameValue)}。
      <span className={`${styles.delta} ${className}`}>
        {label} {delta > 0 ? "+" : ""}
        {formatMoney({ amount: delta, currency: "GAME_CREDIT" })}
      </span>
    </p>
  );
}

function OpeningResult({
  opening,
  onOpenAgain,
  onSellDuplicates
}: {
  opening: PackOpeningDto;
  onOpenAgain: () => void;
  onSellDuplicates: () => void;
}) {
  const resultRef = useRef<HTMLElement>(null);
  const phase = usePackOpeningAnimationStore((state) => state.phase);
  const revealedCount = usePackOpeningAnimationStore((state) => state.revealedCount);
  const revealNext = usePackOpeningAnimationStore((state) => state.revealNext);
  const skip = usePackOpeningAnimationStore((state) => state.skip);
  useEffect(() => {
    resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [opening.id]);
  useEffect(() => {
    if (phase !== "revealing" || revealedCount >= opening.received.length) return;
    const timeout = window.setTimeout(() => revealNext(opening.received.length), 420);
    return () => window.clearTimeout(timeout);
  }, [opening.received.length, phase, revealNext, revealedCount]);
  const isRevealing = phase === "revealing";
  return (
    <section className={styles.result} aria-live="polite" ref={resultRef} tabIndex={-1}>
      <p className="eyebrow">服务端已结算</p>
      <h2>本次开包结果</h2>
      <p>已扣除 {formatMoney(opening.spent)}，并由服务端写入库存。</p>
      <CostValueComparison opening={opening} />
      <div className={styles.revealGrid} aria-label="本次获得卡牌">
        {opening.received.map((card, index) => {
          // 动画状态意外丢失时宁可立即显示已经结算的服务端结果，也不能留下无内容的卡位。
          const visible = phase !== "revealing" || index < revealedCount;
          return (
            <article
              className={visible ? styles.revealedCard : styles.hiddenCard}
              key={`${card.skuId}-${index}`}
            >
              {visible ? (
                <OpeningCardPresentation card={card} />
              ) : (
                <span>正在揭晓第 {index + 1} 项…</span>
              )}
            </article>
          );
        })}
      </div>
      {isRevealing ? (
        <button
          className="button secondary"
          type="button"
          onClick={() => skip(opening.received.length)}
        >
          跳过动画
        </button>
      ) : null}
      <div className="actions">
        <button className="button" type="button" onClick={onOpenAgain}>
          再次开包
        </button>
        <button className="button secondary" type="button" onClick={onSellDuplicates}>
          批量卖出重复卡
        </button>
        <Link className="button secondary" href="/packs/history">
          查看开包历史
        </Link>
      </div>
    </section>
  );
}

/** I33F（I33B C7）：批量开包汇总卡片；汇总数值全部来自服务端，浏览器不统计。 */
function BulkResultSection({
  bulk,
  onBackToPacks
}: {
  bulk: BulkPackOpeningDto;
  onBackToPacks: () => void;
}) {
  const { summary } = bulk;
  return (
    <section className={styles.result} aria-live="polite" tabIndex={-1}>
      <p className="eyebrow">服务端已结算</p>
      <h2>批量开包完成</h2>
      <div className={styles.bulkSummaryGrid} aria-label="批量开包汇总">
        <article>
          <span>包数</span>
          <strong>{summary.count} 包</strong>
        </article>
        <article>
          <span>总成本</span>
          <strong>{formatMoney(summary.totalCost)}</strong>
        </article>
        <article>
          <span>服务端总估值</span>
          <strong>{summary.totalGameValue === null ? "暂不可用" : formatMoney(summary.totalGameValue)}</strong>
        </article>
        <article>
          <span>新加入收藏 SKU</span>
          <strong>{summary.newSkuCount} 种</strong>
        </article>
      </div>
      {summary.rarityCounts.length > 0 ? (
        <p className={styles.metadata}>
          稀有度分布：{summary.rarityCounts.map((item) => `${item.rarity} × ${item.quantity}`).join("，")}
        </p>
      ) : null}
      {summary.totalGameValue === null ? (
        <p className={styles.metadata}>
          服务端暂无有效报价，本批总估值暂不可用；单卡报价出现后可在开包历史中查看逐包记录。
        </p>
      ) : null}
      <details className={styles.bulkDrill}>
        <summary>逐包下钻（只读已结算结果）</summary>
        <div className={styles.bulkPerPack}>
          {bulk.openings.map((opening, index) => (
            <article key={opening.id} className={styles.bulkPack}>
              <h3>第 {index + 1} 包</h3>
              <p className={styles.metadata}>
                成本 {formatMoney(opening.totalCost)}
                {opening.totalGameValue === null ? "；估值暂不可用" : `；服务端估值 ${formatMoney(opening.totalGameValue)}`}
              </p>
              <ul className={styles.bulkPackCards}>
                {opening.received.map((card, cardIndex) => (
                  <li key={`${opening.id}-${card.skuId}-${cardIndex}`}>
                    <OpeningCardPresentation card={card} className={styles.historyOpeningCard} />
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </details>
      <div className="actions">
        <button className="button" type="button" onClick={onBackToPacks}>
          返回补充包商店
        </button>
        <Link className="button secondary" href="/packs/history">
          查看开包历史
        </Link>
      </div>
    </section>
  );
}

function PackCard({
  pack,
  onPurchase,
  onBulk
}: {
  pack: PackDto;
  onPurchase: (pack: PackDto) => void;
  onBulk: (pack: PackDto) => void;
}) {
  const purchasable = packPurchasable(pack);
  const offerReason = offerUnavailableReason(pack.offer);
  return (
    <article className={styles.card}>
      <div className={styles.cardTop}>
        <div className={`${styles.packGraphic} ${purchasable ? "" : styles.packGraphicDisabled}`} aria-hidden="true">
          <span className={styles.packBanding} />
          <span className={styles.packGem} />
          <span className={styles.packName}>PACK</span>
          <span className={styles.packBanding} />
        </div>
        <div className={styles.cardBody}>
          <div className={styles.cardTitleRow}>
            <h2>{pack.name}</h2>
            <span className="seal">{formatMoney(pack.price)}</span>
          </div>
          {pack.description ? (
            <p>{pack.description}</p>
          ) : (
            <p className={styles.metadata}>未提供补充包说明。</p>
          )}
          <p className={styles.metadata}>规则版本：{pack.ruleVersion}</p>
        </div>
      </div>
      <OfferBadge pack={pack} />
      <PackStatus pack={pack} />
      <div className="actions">
        <Link className="button secondary" href={`/packs/${pack.id}`}>
          查看概率详情
        </Link>
        <button
          className="button"
          type="button"
          disabled={!purchasable}
          title={offerReason ?? undefined}
          onClick={() => onPurchase(pack)}
        >
          购买并开包
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!purchasable}
          title={offerReason ?? undefined}
          onClick={() => onBulk(pack)}
        >
          批量开包
        </button>
      </div>
    </article>
  );
}

/** 商店只提交服务端预览中给出的版本；动画仅展示已经结算的结果。 */
export function PacksPage() {
  const packs = usePacksQuery();
  const [selectedPack, setSelectedPack] = useState<PackDto | null>(null);
  const [bulkPack, setBulkPack] = useState<PackDto | null>(null);
  const [opening, setOpening] = useState<PackOpeningDto | null>(null);
  const [bulk, setBulk] = useState<BulkPackOpeningDto | null>(null);
  const [duplicatesOpen, setDuplicatesOpen] = useState(false);
  const [duplicatesResult, setDuplicatesResult] = useState<DuplicatesSellResultDto | null>(null);
  const startAnimation = usePackOpeningAnimationStore((state) => state.start);
  const resetAnimation = usePackOpeningAnimationStore((state) => state.reset);
  const beginPurchase = (pack: PackDto) => setSelectedPack(pack);
  const beginBulk = (pack: PackDto) => setBulkPack(pack);
  const onOpened = (nextOpening: PackOpeningDto) => {
    setSelectedPack(null);
    setOpening(nextOpening);
    startAnimation();
  };
  const onBulkOpened = (nextBulk: BulkPackOpeningDto) => {
    setBulkPack(null);
    setOpening(null);
    setBulk(nextBulk);
  };
  const openAgain = () => {
    const pack = packs.data?.data.items.find((item) => item.id === opening?.packId);
    resetAnimation();
    if (pack) setSelectedPack(pack);
  };
  if (packs.isPending) return <PageSkeleton label="正在加载补充包" />;
  if (packs.isError)
    return (
      <main className="page">
        <ErrorState title="补充包加载失败" onRetry={() => void packs.refetch()} />
      </main>
    );
  const items = packs.data.data.items;
  return (
    <main className="page">
      <p className="eyebrow">服务端版本化配置</p>
      <h1>补充包商店</h1>
      <p className="intro">
        购买前先读取服务端预览；确认后只提交补充包与规则版本。扣款、随机开包、库存和历史记录均由服务端一次性完成。
      </p>
      <p>
        <Link href="/packs/history">查看开包历史</Link>
      </p>
      {opening ? (
        <OpeningResult
          opening={opening}
          onOpenAgain={openAgain}
          onSellDuplicates={() => {
            setDuplicatesResult(null);
            setDuplicatesOpen(true);
          }}
        />
      ) : null}
      {bulk ? <BulkResultSection bulk={bulk} onBackToPacks={() => setBulk(null)} /> : null}
      {duplicatesResult ? <DuplicatesSellResultBanner result={duplicatesResult} /> : null}
      {items.length === 0 ? (
        <EmptyState title="暂无可公示的补充包">
          管理员尚未发布补充包配置。请稍后刷新查看。
        </EmptyState>
      ) : (
        <section className={styles.cards} aria-label="补充包列表">
          {items.map((pack) => (
            <PackCard key={pack.id} pack={pack} onPurchase={beginPurchase} onBulk={beginBulk} />
          ))}
        </section>
      )}
      {selectedPack ? (
        <PurchaseDialog
          pack={selectedPack}
          onClose={() => setSelectedPack(null)}
          onOpened={onOpened}
        />
      ) : null}
      {bulkPack ? (
        <BulkPurchaseDialog pack={bulkPack} onClose={() => setBulkPack(null)} onOpened={onBulkOpened} />
      ) : null}
      <DuplicatesSellDialog
        open={duplicatesOpen}
        onClose={() => setDuplicatesOpen(false)}
        onSettled={(result) => {
          setDuplicatesOpen(false);
          setDuplicatesResult(result);
        }}
      />
    </main>
  );
}

function OpeningSummary({ opening }: { opening: PackOpeningDto }) {
  return (
    <article className={styles.historyCard}>
      <h2>{opening.openedAt}</h2>
      <p>
        <strong>消费：</strong>
        {formatMoney(opening.spent)} · 规则版本：{opening.packRuleVersion}
      </p>
      <CostValueComparison opening={opening} />
      <ul>
        {opening.received.map((card, index) => (
          <li key={`${opening.id}-${card.skuId}-${index}`}>
            <OpeningCardPresentation card={card} className={styles.historyOpeningCard} />
          </li>
        ))}
      </ul>
    </article>
  );
}

/** 历史完全由服务端读取；刷新后不会伪造上次动画或新的开奖结果。 */
export function PackOpeningHistoryPage() {
  const [cursor, setCursor] = useState<string | null>(null);
  const history = usePackOpeningsQuery(cursor);
  if (history.isPending) return <PageSkeleton label="正在加载开包历史" />;
  if (history.isError)
    return (
      <main className="page">
        <ErrorState title="开包历史加载失败" onRetry={() => void history.refetch()} />
      </main>
    );
  const page = history.data.data;
  return (
    <main className={`page ${styles.history}`}>
      <Link className="back-link" href="/packs">
        返回补充包商店
      </Link>
      <p className="eyebrow">服务端已结算记录</p>
      <h1>开包历史</h1>
      <p className="intro">
        刷新后只读取已保存的服务端结果；不会重新扣款、抽取或播放一段伪造动画。
      </p>
      <button className="button secondary" type="button" onClick={() => void history.refetch()}>
        刷新历史
      </button>
      {page.items.length === 0 ? (
        <EmptyState title="还没有开包记录">完成一次服务端开包后，记录会出现在这里。</EmptyState>
      ) : (
        <section className={styles.historyList} aria-label="开包历史列表">
          {page.items.map((opening) => (
            <OpeningSummary key={opening.id} opening={opening} />
          ))}
        </section>
      )}
      <div className="actions">
        <button
          className="button secondary"
          type="button"
          disabled={!cursor}
          onClick={() => setCursor(null)}
        >
          返回最新
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={!page.page.hasMore || !page.page.nextCursor}
          onClick={() => setCursor(page.page.nextCursor)}
        >
          更早记录
        </button>
      </div>
    </main>
  );
}

export function PackDetailPage({ packId }: { packId: string }) {
  const packQuery = usePackDetailQuery(packId);
  if (packQuery.isPending) return <PageSkeleton label="正在加载补充包详情" />;
  if (packQuery.isError)
    return (
      <main className="page">
        <ErrorState title="补充包详情加载失败" onRetry={() => void packQuery.refetch()} />
      </main>
    );
  const pack = packQuery.data.data.pack;
  return (
    <main className={`page ${styles.detail}`}>
      <Link className="back-link" href="/packs">
        返回补充包商店
      </Link>
      <div className={styles.detailHeader}>
        <div>
          <p className="eyebrow">服务端版本化概率</p>
          <h1>{pack.name}</h1>
        </div>
        <Tag color={pack.enabled ? "green" : "default"}>{pack.enabled ? "已启用" : "已禁用"}</Tag>
      </div>
      {pack.description ? <p className="intro">{pack.description}</p> : null}
      <OfferBadge pack={pack} />
      <Descriptions
        bordered
        column={1}
        size="small"
        items={[
          { key: "price", label: "价格", children: formatMoney(pack.price) },
          { key: "ruleVersion", label: "规则版本", children: pack.ruleVersion },
          { key: "updatedAt", label: "配置更新时间（UTC）", children: pack.updatedAt }
        ]}
      />
      <div className={styles.slotList}>
        <PackStatus pack={pack} />
        <PackProbabilityTable slots={pack.slots} />
      </div>
      <section className="status-card">
        <h2>概率与保底说明</h2>
        <p>
          这里展示的是服务端发布的规则版本与卡位概率。MVP
          未启用保底机制，因此没有保底进度、计数器或跨包状态可显示或保存。
        </p>
        <Link className="button" href="/packs">
          返回商店购买
        </Link>
      </section>
    </main>
  );
}
