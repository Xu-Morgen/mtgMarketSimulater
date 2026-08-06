"use client";

import type { CollectionSetGroupDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef } from "react";
import { useCollectionAlbumQuery } from "../../api/collection-api";
import { useAchievementsQuery } from "../../api/achievements-api";
import { useRecordViewStepMutation } from "../../api/onboarding-api";
import { EmptyState, ErrorState, PageSkeleton, Pagination } from "../../components/ui";
import { formatBasisPoints } from "../../utils/percent";
import styles from "./album-page.module.css";

const pageSize = 20;

function filtersFromSearch(search: URLSearchParams): {
  onlyHeld: "any" | "held";
  cursor: string | undefined;
} {
  const held = search.get("onlyHeld") === "held" ? "held" : "any";
  const cursor = search.get("cursor") ?? undefined;
  return { onlyHeld: held, cursor };
}

function toUrl(onlyHeld: "any" | "held", cursor: string | undefined): string {
  const search = new URLSearchParams();
  if (onlyHeld === "held") search.set("onlyHeld", "held");
  if (cursor) search.set("cursor", cursor);
  const suffix = search.toString();
  return suffix ? `/collection/album?${suffix}` : "/collection/album";
}

function rarityLabel(rarity: string): string {
  const labels: Record<string, string> = {
    common: "普通",
    uncommon: "非普通",
    rare: "稀有",
    mythic: "秘稀",
    special: "特典"
  };
  return labels[rarity] ?? rarity;
}

/** 未收集卡位：灰影占位（稀有度描边仅作视觉暗示），不提供交易或估值入口。 */
function UncollectedCard({
  card
}: {
  card: { name: string; setCode: string; collectorNumber: string; rarity: string };
}) {
  return (
    <div
      className={styles.silhouette}
      data-rarity={card.rarity.toLowerCase()}
      aria-label={`未收集：${card.name}（${rarityLabel(card.rarity)}）`}
    >
      <span className="rarity-dot" data-rarity={card.rarity.toLowerCase()} aria-hidden="true" />
      <strong>{card.name}</strong>
      <span className={styles.silhouetteMeta}>
        {card.setCode} · #{card.collectorNumber}
      </span>
      <span className={styles.silhouetteStamp}>未收集</span>
    </div>
  );
}

function SetGroup({ set }: { set: CollectionSetGroupDto }) {
  const progress = formatBasisPoints(set.completionBasisPoints);
  return (
    <article className={styles.setCard}>
      <header className={styles.setHeader}>
        <div>
          <p className="eyebrow">{set.setCode}</p>
          <h2>{set.setName}</h2>
        </div>
        <span className={styles.completionChip}>{progress}</span>
      </header>
      <p className={styles.setMeta}>
        已收集 <strong>{set.collectedSkuCount}</strong> / {set.totalSkuCount} 种印刷·工艺 SKU
      </p>
      <div className={styles.progressTrack} aria-hidden="true">
        <div className={styles.progressFill} style={{ width: progress }} />
      </div>
      {set.uncollectedCards.length === 0 ? (
        <p className={styles.complete}>该系列已全部收集（完成度由服务端核算）。</p>
      ) : (
        <div className={styles.uncollectedGrid}>
          {set.uncollectedCards.map((card) => (
            <UncollectedCard key={`${card.collectorNumber}-${card.name}`} card={card} />
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * I33F：收藏册图鉴页。按系列分组网格展示服务端聚合的完成度与未收集卡位灰影占位；
 * 全部数据来自 `GET /v1/collection/album`，浏览器不统计数量、不估值、不推导里程碑。
 */
export function CollectionAlbumPage() {
  const search = useSearchParams();
  const router = useRouter();
  const { onlyHeld, cursor } = filtersFromSearch(search);
  const album = useCollectionAlbumQuery({ onlyHeld, cursor, limit: pageSize });
  const achievements = useAchievementsQuery();
  const recordView = useRecordViewStepMutation();
  const viewSubmitted = useRef(false);
  useEffect(() => {
    if (viewSubmitted.current) return;
    viewSubmitted.current = true;
    recordView.mutate({ stepId: "unlock-collection-album", path: "/collection/album" });
  }, [recordView]);
  const setOnlyHeld = useCallback(
    (held: "any" | "held") => {
      router.push(toUrl(held, undefined));
    },
    [router]
  );
  const switchPage = useCallback(
    (nextCursor: string | undefined) => {
      router.push(toUrl(onlyHeld, nextCursor));
    },
    [onlyHeld, router]
  );

  if (album.isPending) return <PageSkeleton label="正在加载收藏图鉴" />;
  if (album.isError) {
    return (
      <main className="page">
        <ErrorState title="收藏图鉴加载失败" onRetry={() => void album.refetch()} />
      </main>
    );
  }
  const page = album.data.data.sets;
  const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
  const pageNumber = Math.floor(offset / pageSize) + 1;
  const collectionMilestones = (achievements.data?.data.items ?? []).filter(
    (item) => item.definition.kind === "collection"
  );

  return (
    <main id="onboarding-collection-album" className="page">
      <Link className="back-link" href="/collection">
        返回收藏册
      </Link>
      <p className="eyebrow">服务端收藏聚合</p>
      <h1 id="onboarding-collection-album-focus">收藏图鉴</h1>
      <p className="intro">
        按系列分组的图鉴、每系列完成度与未收集卡位均由服务端核算；浏览器只展示，不统计、不估值、不解锁里程碑。
      </p>
      <div className={styles.toolbar}>
        <div className={styles.segmented} role="group" aria-label="图鉴范围">
          <button
            type="button"
            className={onlyHeld === "any" ? styles.segmentActive : ""}
            onClick={() => setOnlyHeld("any")}
            aria-pressed={onlyHeld === "any"}
          >
            全部系列
          </button>
          <button
            type="button"
            className={onlyHeld === "held" ? styles.segmentActive : ""}
            onClick={() => setOnlyHeld("held")}
            aria-pressed={onlyHeld === "held"}
          >
            仅持有
          </button>
        </div>
        <Link className="button secondary" href="/achievements">
          查看收藏里程碑成就
        </Link>
      </div>

      {page.items.length === 0 ? (
        <EmptyState title="暂无图鉴系列">
          服务端目录还没有可展示的系列，或尚未持有任何系列卡牌。
        </EmptyState>
      ) : (
        <div className={styles.setGrid}>
          {page.items.map((set) => (
            <SetGroup key={set.setCode} set={set} />
          ))}
        </div>
      )}
      <Pagination
        page={pageNumber}
        hasNext={page.page.hasMore}
        onPrevious={() =>
          switchPage(offset > 0 ? String(Math.max(0, offset - pageSize)) : undefined)
        }
        onNext={() => switchPage(page.page.nextCursor ?? undefined)}
      />

      {collectionMilestones.length > 0 ? (
        <section className={styles.milestones} aria-labelledby="milestones-title">
          <h2 id="milestones-title">收藏里程碑联动</h2>
          <p className={styles.milestonesIntro}>
            进度、解锁与奖励均来自服务端成就系统；只读展示，解锁与发放由服务端自动处理。
          </p>
          <ul className={styles.milestoneList}>
            {collectionMilestones.map((item) => {
              const unlocked = item.progress?.status === "unlocked";
              return (
                <li key={item.definition.id}>
                  <div>
                    <strong>{item.definition.display.title}</strong>
                    <span className={styles.milestoneDesc}>
                      {item.definition.display.description}
                    </span>
                    <span className={styles.milestoneProgress}>
                      进度：{item.progress?.currentValue ?? 0} /{" "}
                      {item.progress?.goalValue ?? item.definition.goal}
                      {item.definition.reward.kind === "GAME_CREDIT"
                        ? `；奖励 ${item.definition.reward.amount} 游戏币`
                        : item.definition.reward.badgeId
                          ? `；奖励徽章 ${item.definition.reward.badgeId}`
                          : ""}
                    </span>
                  </div>
                  <span
                    className={`${styles.milestoneBadge} ${unlocked ? styles.milestoneUnlocked : ""}`}
                  >
                    {unlocked ? "已解锁" : "未解锁"}
                  </span>
                  <Link
                    className="text-button"
                    href={`/achievements/${encodeURIComponent(item.definition.id)}`}
                  >
                    查看服务端进度
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </main>
  );
}
