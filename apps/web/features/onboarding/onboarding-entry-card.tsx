"use client";

import type { OnboardingDto } from "@mtg-market/contracts";
import Link from "next/link";
import { ErrorState, PageSkeleton } from "../../components/ui";
import { useOnboardingQuery } from "../../api/onboarding-api";
import styles from "./onboarding-entry-card.module.css";

/**
 * I36F 玩家首页常驻引导入口：未完成玩家显示引导徽标（进行中 x/y 或可领取完成奖励），
 * 完成并领取后显示已完成；进度与状态只取服务端响应，刷新后不伪造进度。
 */
export function OnboardingEntryCard() {
  const onboarding = useOnboardingQuery();

  if (onboarding.isPending) return <PageSkeleton label="正在加载新手引导入口" />;
  if (onboarding.isError) {
    return <section className={styles.card} aria-labelledby="onboarding-entry-title"><h2 id="onboarding-entry-title">新手引导</h2><ErrorState title="引导入口加载失败" onRetry={() => void onboarding.refetch()} /></section>;
  }
  const data = onboarding.data?.data.onboarding as OnboardingDto | undefined;
  if (!data) return <section className={styles.card} aria-labelledby="onboarding-entry-title"><h2 id="onboarding-entry-title">新手引导</h2><ErrorState title="引导入口加载失败" onRetry={() => void onboarding.refetch()} /></section>;

  const badge = !data.allCompleted
    ? { label: `引导进行中 ${data.completedCount}/${data.totalCount}`, className: styles.badgeActive }
    : data.reward.status === "available"
      ? { label: "引导完成 · 可领取完成奖励", className: styles.badgeReady }
      : { label: "引导已完成", className: styles.badgeDone };

  return (
    <section className={styles.card} aria-labelledby="onboarding-entry-title">
      <h2 id="onboarding-entry-title">新手引导</h2>
      <div className={styles.row}>
        <span className={`${styles.badge} ${badge.className}`} role="status">{badge.label}</span>
        <Link className="button secondary" href="/onboarding">{data.currentStepId ? "继续引导" : "查看新手引导"}</Link>
      </div>
      <p className={styles.hint}>
        {data.currentStepId
          ? <>下一步：{data.steps.find((step) => step.id === data.currentStepId)?.title ?? ""}</>
          : data.reward.status === "available"
            ? <>全部步骤已完成，前往新手引导领取一次性完成奖励（服务端入账）。</>
            : "已完成首次目标链，所有状态以服务器记录为准。"}
      </p>
      <p className={styles.meta}>规则版本：{data.ruleVersion}</p>
    </section>
  );
}
