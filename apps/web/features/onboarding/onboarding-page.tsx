"use client";

import type { OnboardingDto, OnboardingStepDto } from "@mtg-market/contracts";
import Link from "next/link";
import { useRef, useState } from "react";
import { ApiClientError } from "../../api/client";
import { useClaimOnboardingRewardMutation, useOnboardingQuery, useSkipStepMutation } from "../../api/onboarding-api";
import { ConfirmDialog, ErrorState, PageSkeleton } from "../../components/ui";
import { formatMoney } from "../../utils/money";
import styles from "./onboarding-page.module.css";

function stepStateChip(step: OnboardingStepDto, currentStepId: string | null): { label: string; className: string } {
  if (step.completion === "skip") return { label: "已跳过", className: styles.skipped ?? "" };
  if (step.completion === "auto") return { label: "已完成", className: styles.done ?? "" };
  if (step.id === currentStepId) return { label: "下一步", className: styles.current ?? "" };
  return { label: "待完成", className: styles.pending ?? "" };
}

function StepCard({ step, currentStepId, skipping, onSkip }: {
  step: OnboardingStepDto;
  currentStepId: string | null;
  skipping: boolean;
  onSkip: () => void;
}) {
  const chip = stepStateChip(step, currentStepId);
  const done = step.completion !== null;
  return (
    <li className={`${styles.stepCard}${step.id === currentStepId ? ` ${styles.current}` : ""}${done ? ` ${styles.done}` : ""}`}>
      <span className={styles.stepOrder} aria-hidden="true">{step.order}</span>
      <div className={styles.stepMain}>
        <h2 className={styles.stepTitle}>{step.title}</h2>
        <p className={styles.stepDesc}>{step.description}</p>
        <div className={styles.stepState}>
          <span className={`${styles.stateChip} ${chip.className}`}>{chip.label}</span>
          {step.skippable ? <span className={`${styles.stateChip} ${styles.pending}`}>可跳过</span> : null}
        </div>
      </div>
      <div className={styles.stepActions}>
        <Link className={done ? "button secondary" : "button"} href={step.href}>{done ? "再次进入" : "去完成"}</Link>
        {step.skippable && !done ? (
          <button className="button secondary" type="button" disabled={skipping} onClick={onSkip}>{skipping ? "正在跳过…" : "跳过此步骤"}</button>
        ) : null}
      </div>
    </li>
  );
}

/** I36F（I36B 新手引导）引导页：步骤进度、跳过与完成奖励只以服务端响应为准，刷新后不伪造进度。 */
export function OnboardingPage() {
  const onboarding = useOnboardingQuery();
  const skip = useSkipStepMutation();
  const claim = useClaimOnboardingRewardMutation();
  const [pendingSkip, setPendingSkip] = useState<OnboardingStepDto | null>(null);
  const [pendingClaim, setPendingClaim] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [claimResult, setClaimResult] = useState<string | null>(null);
  const claimLock = useRef(false);
  const skipLock = useRef(false);

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

  const confirmSkip = () => {
    if (!pendingSkip || skip.isPending || skipLock.current) return;
    const stepId = pendingSkip.id;
    skipLock.current = true;
    setPendingSkip(null);
    skip.mutate({ stepId }, {
      onSettled: () => {
        skipLock.current = false;
      }
    });
  };

  const confirmClaim = () => {
    if (claim.isPending || claimLock.current) return;
    setPendingClaim(false);
    setClaimError(null);
    setClaimResult(null);
    claimLock.current = true;
    claim.mutate(undefined, {
      onSuccess: ({ data }) => {
        claimLock.current = false;
        const reward = data.reward;
        setClaimResult(`已领取引导完成奖励 ${formatMoney(reward.reward)}，当前可用余额 ${formatMoney(reward.balance)}（由服务器入账）。`);
      },
      onError: (error) => {
        claimLock.current = false;
        setClaimError(error instanceof ApiClientError ? error.message : error instanceof Error ? error.message : "领取引导完成奖励未完成，请重试。");
      }
    });
  };

  return (
    <main className="page">
      <p className="eyebrow">服务端首次目标链</p>
      <h1>新手引导</h1>
      <p className="intro">完成“第一次赚钱 → 开包 → 看懂价格 → 第一笔交易 → 收藏见涨 → 首次报名”的目标链。每个步骤的完成判定只由服务器基于已结算事实推进；页面只展示服务端结果并提交「去完成 / 跳过 / 领取奖励」的意图，刷新后不会伪造进度。</p>

      <section className={styles.summary} aria-labelledby="onboarding-summary-title">
        <h2 id="onboarding-summary-title" className="sr-only">引导进度摘要</h2>
        <div className={styles.summaryRow}>
          <div className={styles.progressTrack} role="img" aria-label={`引导进度 ${percent}%`}>
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
          <p className={styles.summaryText}>
            已完成 <strong>{data.completedCount} / {data.totalCount}</strong> 步
            {data.currentStepId ? <>，下一步：<strong className={styles.currentHint}>{data.steps.find((step) => step.id === data.currentStepId)?.title ?? ""}</strong></> : null}
          </p>
        </div>
        <p className={styles.ruleMeta}>规则版本：{data.ruleVersion} · 服务端更新时间：{data.updatedAt}</p>
      </section>

      <ol className={styles.stepList}>
        {data.steps.map((step) => (
          <StepCard key={step.id} step={step} currentStepId={data.currentStepId} skipping={skip.isPending && skip.variables?.stepId === step.id} onSkip={() => { setClaimResult(null); setClaimError(null); setPendingSkip(step); }} />
        ))}
      </ol>

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

      <ConfirmDialog
        open={pendingSkip !== null}
        title="确认跳过此步骤"
        description={pendingSkip ? `将「${pendingSkip.title}」标记为已跳过（老玩家补完目标链的路径），由服务器记录，跳过视为已完成且不可恢复。重复点击只提交一次。是否确认？` : ""}
        onCancel={() => setPendingSkip(null)}
        onConfirm={confirmSkip}
      />
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
