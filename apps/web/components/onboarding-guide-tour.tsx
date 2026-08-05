"use client";

import { Tour, type TourProps } from "antd";
import type { OnboardingDto, OnboardingStepDto } from "@mtg-market/contracts";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { useOnboardingQuery, useSkipStepMutation } from "../api/onboarding-api";
import { useOnboardingGuide } from "../providers/onboarding-guide-context";
import styles from "./onboarding-guide-tour.module.css";

/** 每个引导步骤在对应功能页上的目标按钮/区块锚点 id；不存在的页面在 Tour 中以居中卡片展示。 */
const ANCHOR_ID_BY_STEP: Record<string, string> = {
  "create-archive": "onboarding-create-archive",
  "claim-work-funds": "onboarding-work-funds",
  "open-first-pack": "onboarding-pack-purchase",
  "view-price-history": "onboarding-view-price-history",
  "complete-first-npc-trade": "onboarding-npc-buy",
  "unlock-collection-album": "onboarding-collection-album",
  "first-tournament-registration": "onboarding-tournaments"
};

function anchorIdFor(stepId: string): string | null {
  return ANCHOR_ID_BY_STEP[stepId] ?? null;
}

function anchorOnPage(stepId: string): boolean {
  const id = anchorIdFor(stepId);
  return Boolean(id && typeof document !== "undefined" && document.getElementById(id));
}

function tourStepTitle(step: OnboardingStepDto, data: OnboardingDto): string {
  if (step.completion !== null) return `${step.title}（已完成）`;
  if (step.id === data.currentStepId) return `下一步：${step.title}`;
  return step.title;
}

/**
 * I36F 新手引导 Tour：跨页面常驻（挂在 (player) 布局）。引导会话目标步骤由引导页/玩家首页
 * 入口写入，切换页面不丢失当前步骤；步骤完成（服务端推进）后自动前进到下一个未完成步骤。
 * 目标按钮锚点存在时高亮该按钮并允许直接点击（蒙层不拦截），否则以居中卡片展示并提供
 * 「去完成 →」跳转；跳过为显式幂等命令（服务端判定，重放不重复计数）。
 */
export function OnboardingGuideTour() {
  const { targetStepId, retarget } = useOnboardingGuide();
  const router = useRouter();
  const pathname = usePathname();
  // 常驻 Tour：仅在引导会话激活或位于引导页时才请求引导投影（避免每个玩家页面都轮询）。
  const onboarding = useOnboardingQuery({ enabled: pathname === "/onboarding" || targetStepId !== null });
  const skip = useSkipStepMutation();
  const skipLock = useRef(false);
  const data = onboarding.data?.data.onboarding;

  // 进入引导页时自动开始本次引导会话（从当前未完成步骤开始）；已完成全部步骤时不启动。
  useEffect(() => {
    if (!data || targetStepId !== null || data.allCompleted) return;
    if (pathname === "/onboarding") retarget(data.currentStepId ?? data.steps[0]?.id ?? null);
  }, [data, pathname, targetStepId, retarget]);

  // 当前步骤完成后自动前进到下一个未完成步骤；全部完成则结束会话（奖励在引导页领取）。
  useEffect(() => {
    if (!data || targetStepId === null) return;
    const idx = data.steps.findIndex((step) => step.id === targetStepId);
    if (idx === -1 || data.steps[idx]?.completion !== null) {
      if (data.allCompleted) retarget(null);
      else retarget(data.currentStepId);
    }
  }, [data, targetStepId, retarget]);

  if (!data || targetStepId === null || data.allCompleted) return null;

  const current = Math.max(0, data.steps.findIndex((step) => step.id === targetStepId));
  const goPrev = () => {
    const prev = current - 1;
    if (prev >= 0 && data.steps[prev]) retarget(data.steps[prev]!.id);
  };
  const goNext = () => {
    const next = current + 1;
    if (next < data.steps.length && data.steps[next]) retarget(data.steps[next]!.id);
  };
  const finish = () => retarget(null);
  const goTo = (href: string) => router.push(href);
  const skipStep = (step: OnboardingStepDto) => {
    if (skip.isPending || skipLock.current) return;
    skipLock.current = true;
    skip.mutate({ stepId: step.id }, { onSettled: () => { skipLock.current = false; } });
  };

  const steps: NonNullable<TourProps["steps"]> = data.steps.map((step) => {
    const done = step.completion !== null;
    const isLastStep = step.order === data.steps.length;
    const anchorId = anchorIdFor(step.id);
    const targetHere = anchorOnPage(step.id);
    const primaryLabel = done ? "继续" : targetHere ? (isLastStep ? "完成引导" : "下一步") : "去完成 →";
    return {
      title: tourStepTitle(step, data),
      description: step.description,
      placement: targetHere ? "right" : "center",
      target: anchorId ? (() => document.getElementById(anchorId) ?? null) as () => HTMLElement : null,
      actionsRender: (_, info) => (
        <div className={styles.actions}>
          <div className={styles.nav}>
            {info.current > 0 ? <button className="button secondary" type="button" onClick={goPrev}>上一步</button> : null}
          </div>
          <div className={styles.main}>
            {step.skippable && !done ? (
              <button className="text-button" type="button" disabled={skip.isPending} onClick={() => skipStep(step)}>
                {skip.isPending && skip.variables?.stepId === step.id ? "正在跳过…" : "跳过此步"}
              </button>
            ) : null}
            <button className="button" type="button" onClick={() => {
              if (done || targetHere) {
                if (isLastStep) finish();
                else goNext();
              } else {
                // 跨页步骤：先跳到目标功能页，当前步骤保留以高亮该页按钮。
                goTo(step.href);
              }
            }}>{primaryLabel}</button>
          </div>
        </div>
      )
    };
  });

  return (
    <Tour
      open
      current={current}
      steps={steps}
      onChange={(next) => {
        if (next >= 0 && next < data.steps.length && data.steps[next]) retarget(data.steps[next]!.id);
      }}
      onClose={finish}
      onFinish={finish}
      className={styles.tour ?? ""}
    />
  );
}
