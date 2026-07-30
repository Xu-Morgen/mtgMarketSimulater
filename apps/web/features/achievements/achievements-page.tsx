"use client";

import type {
  AchievementDefinitionDto,
  AchievementProgressDto,
  AchievementRewardDetailDto,
  AchievementUnlockDto
} from "@mtg-market/contracts";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  type AchievementOverviewItem,
  useAchievementDetailQuery,
  useAchievementsQuery
} from "../../api/achievements-api";
import { EmptyState, ErrorState, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import styles from "./achievements-page.module.css";

function timestamp(value: string | null): string {
  return value
    ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(value)
      )
    : "—";
}

function progressText(
  definition: AchievementDefinitionDto,
  progress: AchievementProgressDto | null
): string {
  return `${progress?.currentValue ?? 0} / ${progress?.goalValue ?? definition.goal}`;
}

function rewardText(reward: AchievementRewardDetailDto): string {
  if (reward.kind === "GAME_CREDIT")
    return `${formatMoney({ amount: reward.amount, currency: "GAME_CREDIT" })} 游戏币`;
  if (reward.kind === "sku") return `服务端指定 SKU：${reward.skuId ?? "—"}`;
  return `展示徽章：${reward.badgeId ?? "—"}`;
}

function state(
  progress: AchievementProgressDto | null,
  unlock: AchievementUnlockDto | null
): {
  label: string;
  className: string;
  explanation: string;
} {
  if (!progress || progress.status === "pending") {
    return {
      label: "未解锁",
      className: styles.pending ?? "",
      explanation: "继续完成服务端记录的目标即可推进进度。"
    };
  }
  if (unlock?.rewardStatus === "blocked") {
    return {
      label: "已解锁 · 奖励未发放",
      className: styles.blocked ?? "",
      explanation: "服务端已保留解锁事实；本次奖励被风控拦截，页面不会自行补发。"
    };
  }
  return {
    label: "已解锁 · 奖励已发放",
    className: styles.unlocked ?? "",
    explanation: "奖励由服务端在解锁事务中自动发放，无需在浏览器领取。"
  };
}

function AchievementCard({ item }: { item: AchievementOverviewItem }) {
  const unlocked = item.progress?.status === "unlocked";
  return (
    <article className={styles.card}>
      <div className={styles.cardHead}>
        <div>
          <p className="eyebrow">{item.definition.category}</p>
          <h2>{item.definition.display.title}</h2>
        </div>
        <span className={`${styles.badge} ${unlocked ? styles.unlocked : styles.pending}`}>
          {unlocked ? "已解锁" : "未解锁"}
        </span>
      </div>
      <p>{item.definition.display.description}</p>
      <p className={styles.progress}>进度：{progressText(item.definition, item.progress)}</p>
      <p className={styles.meta}>奖励：{rewardText(item.definition.reward)}</p>
      {unlocked ? (
        <p className={styles.meta}>
          解锁时间：{timestamp(item.progress?.unlockedAt ?? null)}；刚解锁时奖励由服务端自动处理。
        </p>
      ) : null}
      <Link
        className="text-button"
        href={`/achievements/${encodeURIComponent(item.definition.id)}`}
      >
        查看服务端详情与来源
      </Link>
    </article>
  );
}

export function AchievementsPage() {
  const achievements = useAchievementsQuery();
  if (achievements.isPending) return <PageSkeleton label="正在加载成就" />;
  if (achievements.isError) {
    return (
      <main className="page">
        <ErrorState title="成就加载失败" onRetry={() => void achievements.refetch()} />
      </main>
    );
  }
  const items = achievements.data?.data.items ?? [];
  return (
    <main className="page">
      <p className="eyebrow">服务端长期目标</p>
      <h1>成就与收藏里程碑</h1>
      <p className="intro">
        进度、解锁、奖励与来源均由服务端已结算事实提供；本页不会解锁成就、发放奖励或修改收藏。
      </p>
      {items.length === 0 ? (
        <EmptyState title="暂未配置可展示成就">服务端尚未返回成就定义，请稍后刷新。</EmptyState>
      ) : (
        <>
          <p className={styles.summary}>
            共 {items.length} 项目标；已解锁{" "}
            {items.filter((item) => item.progress?.status === "unlocked").length} 项。
          </p>
          <div className={styles.grid}>
            {items.map((item) => (
              <AchievementCard key={item.definition.id} item={item} />
            ))}
          </div>
        </>
      )}
    </main>
  );
}

function SourceLinks({ unlock }: { unlock: AchievementUnlockDto }) {
  const sourceHref = unlock.source.type === "tournament.settled" ? "/tournaments" : "/inventory";
  const sourceLabel =
    unlock.source.type === "tournament.settled" ? "查看关联赛事与历史" : "查看收藏与库存";
  return (
    <div className={styles.sourceLinks}>
      <Link className="button secondary" href={sourceHref}>
        {sourceLabel}
      </Link>
      {unlock.rewardCorrelationId ? (
        <Link className="text-button" href="/dashboard">
          查看账本流水
        </Link>
      ) : null}
    </div>
  );
}

export function AchievementDetailPage() {
  const params = useParams<{ definitionId: string }>();
  const definitionId = params.definitionId ? decodeURIComponent(params.definitionId) : "";
  const detail = useAchievementDetailQuery(definitionId);
  if (detail.isPending) return <PageSkeleton label="正在加载成就详情" />;
  if (detail.isError || !detail.data) {
    return (
      <main className="page">
        <ErrorState title="成就详情加载失败或不存在" onRetry={() => void detail.refetch()} />
      </main>
    );
  }
  const value = detail.data.data;
  const currentState = state(value.progress, value.unlock);
  return (
    <main className="page">
      <Link className="text-button" href="/achievements">
        ← 返回成就列表
      </Link>
      <article className={styles.detail}>
        <p className="eyebrow">
          {value.definition.category} · {value.definition.ruleVersion}
        </p>
        <h1>{value.definition.display.title}</h1>
        <p className="intro">{value.definition.display.description}</p>
        <p>
          <span className={`${styles.badge} ${currentState.className}`}>{currentState.label}</span>
        </p>
        <p className={styles.notice}>{currentState.explanation}</p>
        <dl className={styles.detailList}>
          <div>
            <dt>服务端进度</dt>
            <dd>{progressText(value.definition, value.progress)}</dd>
          </div>
          <div>
            <dt>展示物</dt>
            <dd>{value.definition.display.badge ?? "本成就没有单独展示徽章。"}</dd>
          </div>
          <div>
            <dt>奖励</dt>
            <dd>{rewardText(value.unlock?.reward ?? value.definition.reward)}</dd>
          </div>
          <div>
            <dt>解锁时间</dt>
            <dd>{timestamp(value.unlock?.unlockedAt ?? value.progress?.unlockedAt ?? null)}</dd>
          </div>
          <div>
            <dt>奖励状态</dt>
            <dd>
              {value.unlock
                ? value.unlock.rewardStatus === "granted"
                  ? "已由服务端发放（无需领取）"
                  : "已解锁，但奖励被服务端风控拦截"
                : "尚未产生奖励发放记录"}
            </dd>
          </div>
          {value.unlock ? (
            <>
              <div>
                <dt>来源类型</dt>
                <dd>
                  {value.unlock.source.type === "tournament.settled" ? "已结算赛事" : "收藏进度"}
                </dd>
              </div>
              <div>
                <dt>来源事实 ID</dt>
                <dd>{value.unlock.source.factId ?? "—"}</dd>
              </div>
              <div>
                <dt>来源聚合 ID</dt>
                <dd>{value.unlock.source.aggregateId ?? "—"}</dd>
              </div>
              <div>
                <dt>奖励关联 ID</dt>
                <dd>{value.unlock.rewardCorrelationId ?? "—"}</dd>
              </div>
            </>
          ) : null}
        </dl>
        {value.unlock ? (
          <SourceLinks unlock={value.unlock} />
        ) : (
          <p className={styles.muted}>解锁后将显示赛事或收藏来源及服务端奖励状态。</p>
        )}
      </article>
    </main>
  );
}
