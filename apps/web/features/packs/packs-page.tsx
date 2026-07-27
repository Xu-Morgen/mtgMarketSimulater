"use client";

import { Descriptions, Tag } from "antd";
import type { PackDto, PackOpeningDto, PackPurchasePreviewDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  useOpenPackMutation,
  usePackDetailQuery,
  usePackOpeningsQuery,
  usePackPurchasePreviewQuery,
  usePacksQuery
} from "../../api/packs-api";
import { ApiClientError } from "../../api/client";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { usePackOpeningAnimationStore } from "../../stores/pack-opening-animation-store";
import { formatMoney } from "../../utils/money";
import { PackProbabilityTable } from "./pack-probability-table";
import styles from "./packs-page.module.css";

function PackStatus({ pack }: { pack: PackDto }) {
  if (!pack.enabled)
    return (
      <p className={styles.disabled}>
        <strong>当前不可购买：</strong>
        {pack.disabledReason ?? "该补充包暂未启用。"}
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
  const error =
    open.error instanceof ApiClientError
      ? open.error.message
      : open.isError
        ? "开包请求未完成，请使用相同按钮重试。"
        : null;
  const confirm = () => {
    const value = preview.data?.data.preview;
    if (!value?.canPurchase) return;
    open.mutate(
      { packId: value.pack.id, ruleVersion: value.ruleVersion },
      { onSuccess: ({ data }) => onOpened(data.opening) }
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
            disabled={open.isPending}
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
              open.isPending
            }
            onClick={confirm}
          >
            {open.isPending ? "正在由服务端开包…" : "确认购买并开包"}
          </button>
        </div>
      </section>
    </div>
  );
}

function OpeningResult({
  opening,
  onOpenAgain
}: {
  opening: PackOpeningDto;
  onOpenAgain: () => void;
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
                <>
                  <strong>SKU {card.skuId}</strong>
                  <span>数量：{card.quantity}</span>
                  <span>本次分摊成本：{formatMoney(card.cost)}</span>
                </>
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
      {opening.profitLoss.priceStatus === "unavailable_until_i17" ? (
        <p className={styles.metadata}>
          外部参考价和游戏内价将在 I17 后提供；本次结果不展示估值或盈亏。
        </p>
      ) : null}
      <div className="actions">
        <button className="button" type="button" onClick={onOpenAgain}>
          再次开包
        </button>
        <Link className="button secondary" href="/packs/history">
          查看开包历史
        </Link>
      </div>
    </section>
  );
}

function PackCard({ pack, onPurchase }: { pack: PackDto; onPurchase: (pack: PackDto) => void }) {
  return (
    <article className={styles.card}>
      <div>
        <h2>{pack.name}</h2>
        {pack.description ? (
          <p>{pack.description}</p>
        ) : (
          <p className={styles.metadata}>未提供补充包说明。</p>
        )}
      </div>
      <p>
        <strong>价格：</strong>
        {formatMoney(pack.price)}
      </p>
      <p className={styles.metadata}>规则版本：{pack.ruleVersion}</p>
      <PackStatus pack={pack} />
      <div className="actions">
        <Link className="button secondary" href={`/packs/${pack.id}`}>
          查看概率详情
        </Link>
        <button
          className="button"
          type="button"
          disabled={!pack.enabled}
          onClick={() => onPurchase(pack)}
        >
          购买并开包
        </button>
      </div>
    </article>
  );
}

/** 商店只提交服务端预览中给出的版本；动画仅展示已经结算的结果。 */
export function PacksPage() {
  const packs = usePacksQuery();
  const [selectedPack, setSelectedPack] = useState<PackDto | null>(null);
  const [opening, setOpening] = useState<PackOpeningDto | null>(null);
  const startAnimation = usePackOpeningAnimationStore((state) => state.start);
  const resetAnimation = usePackOpeningAnimationStore((state) => state.reset);
  const beginPurchase = (pack: PackDto) => setSelectedPack(pack);
  const onOpened = (nextOpening: PackOpeningDto) => {
    setSelectedPack(null);
    setOpening(nextOpening);
    startAnimation();
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
      {opening ? <OpeningResult opening={opening} onOpenAgain={openAgain} /> : null}
      {items.length === 0 ? (
        <EmptyState title="暂无可公示的补充包">
          管理员尚未发布补充包配置。请稍后刷新查看。
        </EmptyState>
      ) : (
        <section className={styles.cards} aria-label="补充包列表">
          {items.map((pack) => (
            <PackCard key={pack.id} pack={pack} onPurchase={beginPurchase} />
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
      <ul>
        {opening.received.map((card, index) => (
          <li key={`${opening.id}-${card.skuId}-${index}`}>
            SKU {card.skuId} × {card.quantity}（分摊成本 {formatMoney(card.cost)}）
          </li>
        ))}
      </ul>
      {opening.profitLoss.priceStatus === "unavailable_until_i17" ? (
        <p className={styles.metadata}>该记录暂无外部参考价与游戏内价。</p>
      ) : null}
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
