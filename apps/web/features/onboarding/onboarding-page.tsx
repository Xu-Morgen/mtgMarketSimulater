"use client";

import type { OnboardingDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useState } from "react";
import { ApiClientError } from "../../api/client";
import { useClaimOnboardingRewardMutation, useOnboardingQuery } from "../../api/onboarding-api";
import { useOnboardingGuide } from "../../providers/onboarding-guide-context";
import { ConfirmDialog, ErrorState, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import styles from "./onboarding-page.module.css";

/**
 * I36F（I36B 新手引导）引导页：进度摘要、步骤清单与完成奖励领取入口。步骤引导本身由
 * 常驻的 antd Tour（OnboardingGuideTour）以气泡清晰标记目标按钮并跨页面跟进；本页负责
 * 启动引导会话（重新开始会换新引导意图）、展示服务端进度与领取完成奖励。
 * 完成/跳过/奖励状态只以服务端响应为准，刷新后不伪造进度。
 */
export function OnboardingPage() {
  const onboarding = useOnboardingQuery();
  const claim = useClaimOnboardingRewardMutation();
  const guide = useOnboardingGuide();
  const [pendingClaim, setPendingClaim] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimResult, setClaimResult] = useState<string | null>(null);
  const [claimLock, setClaimLock] = useState(false);

  if (onboarding.isPending) return <PageSkeleton label="正在加载新手引导" />;
  if (onboarding.isError) {
    return (
      <main className="page">
        <ErrorState title="新手引导加载失败" onRetry={() => void onboarding.refetch()} />
      </main>
    );
  }
  const data = onboarding.data?.data.onboarding as OnboardingDto | undefined;
  if (!data) return <main className="page"><ErrorState title="新手引导加载失败" onRetry={() => void onboarding.refetch()} /></main>;

  const percent = data.totalCount > 0 ? Math.round((data.completedCount / data.totalCount) * 100) : 0;
  const reward = data.reward;
  const claimPending = claim.isPending;
  const currentStep = data.steps.find((step) => step.id === data.currentStepId) ?? data.steps[0];

  const confirmClaim = () => {
    if (claim.isPending || claimLock) return;
    setPendingClaim(false);
    setClaimError(null);
    setClaimResult(null);
    setClaimLock(true);
    claim.mutate(undefined, {
      onSuccess: ({ data }) => {
        setClaimLock(false);
        const reward = data.reward;
        setClaimResult(`已领取引导完成奖励 ${formatMoney(reward.reward)}，当前可用余额 ${formatMoney(reward.balance)}（由服务器入账）。`);
      },
      onError: (error) => {
        setClaimLock(false);
        setClaimError(error instanceof ApiClientError ? error.message : error instanceof Error ? error.message : "领取引导完成奖励未完成，请重试。");
      }
    });
  };

  return (
    <main className="page">
      <p className="eyebrow">服务端首次目标链</p>
      <h1>新手引导</h1>
      <p className="intro">完成“创建存档 → 第一次赚钱 → 开包 → 看懂价格 → 第一笔交易 → 收藏见涨 → 首次报名”的目标链。点击「开始引导」后，每一步都会以高亮气泡标记页面上的目标按钮并带你在各页面间推进；每个步骤的完成判定只由服务器基于已结算事实推进，刷新后不会伪造进度。</p>

      <section className={styles.summary} aria-labelledby="onboarding-summary-title">
        <h2 id="onboarding-summary-title" className="sr-only">引导进度摘要</h2>
        <div className={styles.summaryRow}>
          <div className={styles.progressTrack} role="img" aria-label={`引导进度 ${percent}%`}>
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
          <p className={styles.summaryText}>
            已完成 <strong>{data.completedCount} / {data.totalCount}</strong> 步
            {!data.allCompleted && currentStep ? <>，下一步：<strong className={styles.currentHint}>{currentStep.title}</strong></> : null}
          </p>
        </div>
        <p className={styles.ruleMeta}>规则版本：{data.ruleVersion} · 服务端更新时间：{data.updatedAt}</p>
      </section>

      <section className={styles.startBar} aria-label="开始引导">
        {data.allCompleted ? (
          <p className={styles.allDone}>全部步骤已完成{reward.status === "claimed" ? "，奖励已领取" : "，可领取完成奖励"}。可在下方重新开始引导回顾目标链。</p>
        ) : (
          <p className={styles.ready}>引导会话尚未开始或已完成到「{currentStep?.title ?? ""}」。点击「开始引导」会以气泡高亮目标按钮并跨页面跟进。</p>
        )}
        <div className="actions">
          <button className="button" type="button" onClick={() => guide.retarget(data.currentStepId ?? data.steps[0]?.id ?? null)}>
            开始引导
          </button>
          <Link className="button secondary" href="/dashboard">返回玩家首页</Link>
        </div>
      </section>

      <section className={styles.rewardCard} aria-labelledby="onboarding-reward-title">
        <h2 id="onboarding-reward-title">引导完成奖励</h2>
        <div className={styles.rewardStatus}>
          <span className={styles.rewardAmount}>{formatMoney(reward.amount)}</span>
          {reward.status === "available" ? (
            <>
              <span className={styles.rewardReady}>全部步骤已完成，奖励可领取（由服务器入账并写入账本流水）。</span>
              <div className="actions"><button className="button" type="button" disabled={claimPending} onClick={() => { setClaimResult(null); setClaimError(null); setPendingClaim(true); }}>{claimPending ? "正在向服务器领取…" : `领取 ${formatMoney(reward.amount)}`}</button></div>
            </>
          ) : reward.status === "claimed" ? (
            <span className={styles.rewardClaimed}>已领取{reward.claimedAt ? `，领取时间 ${reward.claimedAt}` : ""}。</span>
          ) : (
            <span className={styles.rewardClaimed}>完成全部引导步骤后，由服务器发放一次性奖励。</span>
          )}
        </div>
        <div className={styles.resultBar} aria-label="引导奖励领取状态">
          {claimResult ? <p className={styles.claimSuccess} role="status">{claimResult}</p> : null}
          {claimError ? <p className="form-error" role="alert">{claimError}<button className="text-button" type="button" onClick={() => { setClaimError(null); claim.beginNewIntent(); }}>重试</button></p> : null}
        </div>
      </section>

      <ol className={styles.stepList}>
        {data.steps.map((step) => (
          <li key={step.id} className={`${styles.stepCard}${step.id === data.currentStepId ? ` ${styles.current}` : ""}${step.completion !== null ? ` ${styles.done}` : ""}`}>
            <span className={styles.stepOrder} aria-hidden="true">{step.order}</span>
            <div className={styles.stepMain}>
              <h2 className={styles.stepTitle}>{step.title}</h2>
              <p className={styles.stepDesc}>{step.description}</p>
              <div className={styles.stepState}>
                <span className={`${styles.stateChip} ${step.completion === "skip" ? styles.skipped ?? "" : step.completion === "auto" ? styles.done ?? "" : step.id === data.currentStepId ? styles.current ?? "" : styles.pending ?? ""}`}>
                  {step.completion === "skip" ? "已跳过" : step.completion === "auto" ? "已完成" : step.id === data.currentStepId ? "下一步" : "待完成"}
                </span>
                {step.skippable ? <span className={`${styles.stateChip} ${styles.pending}`}>可跳过</span> : null}
              </div>
            </div>
            <div className={styles.stepActions}>
              <button className={step.completion !== null ? "button secondary" : "button"} type="button" onClick={() => guide.retarget(step.id)}>{step.completion !== null ? "再次引导此步" : "引导我完成"}</button>
            </div>
          </li>
        ))}
      </ol>

      <ConfirmDialog
        open={pendingClaim}
        title="确认领取引导完成奖励"
        description={`将领取一次性引导完成奖励 ${formatMoney(reward.amount)}，由服务器入账并写入账本流水。重复点击只提交一次。是否确认？`}
        onCancel={() => setPendingClaim(false)}
        onConfirm={confirmClaim}
      />
    </main>
  );
}
