"use client";

import { Tour, type TourProps } from "antd";
import type { OnboardingDto, OnboardingStepDto } from "@mtg-market/contracts";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useOnboardingQuery, useSkipStepMutation } from "../api/onboarding-api";
import { useOnboardingGuide } from "../providers/onboarding-guide-context";
import styles from "./onboarding-guide-tour.module.css";

/**
 * 每个引导步骤的目标锚点 id 列表（按序解析，取第一个实际存在于 DOM 的）：
 * - 「开出第一包」「完成首笔交易」「首次报名」步骤的弹窗打开后，把目标从页面入口按钮切换到
 *   弹窗内的确认按钮——rc-tour 蒙层会在目标位置留出可点击孔洞，点击穿透到弹窗按钮；
 * - 其余步骤目标直接指向对应功能页按钮/区块；目标页面不存在时以居中卡片展示。
 */
const ANCHOR_IDS_BY_STEP: Record<string, string[]> = {
  "create-archive": ["onboarding-create-archive"],
  "claim-work-funds": ["onboarding-work-funds"],
  "open-first-pack": ["onboarding-pack-confirm", "onboarding-pack-purchase"],
  "view-price-history": ["onboarding-view-price-history"],
  "complete-first-npc-trade": ["onboarding-npc-confirm", "onboarding-npc-buy"],
  "unlock-collection-album": ["onboarding-collection-album"],
  "first-tournament-registration": ["onboarding-tournament-confirm", "onboarding-tournaments"]
};

/** 弹窗确认按钮锚点 → 气泡补充提示（告诉玩家弹窗已打开、在弹窗内点哪个按钮）。 */
const DIALOG_HINTS: Record<string, string> = {
  "onboarding-pack-confirm": "购买弹窗已打开：点击下方「确认购买并开包」完成本步。",
  "onboarding-npc-confirm": "买入确认弹窗已打开：点击下方「确认向 NPC 买入」完成本步。",
  "onboarding-tournament-confirm": "报名确认弹窗已打开：选择已保存卡组后点击「确认报名」完成本步。"
};

/** 步骤 href → 页面名称（气泡内说明当前步骤在哪个页面完成）。 */
const PAGE_LABELS: Record<string, string> = {
  "/dashboard": "玩家首页",
  "/packs": "补充包商店",
  "/market/history": "价格历史页",
  "/market": "市场页",
  "/collection/album": "收藏图鉴页",
  "/tournaments": "今日比赛页"
};

/** 按序解析当前实际存在的目标锚点 id（弹窗打开时确认按钮在 DOM 中，优先于页面入口按钮）。 */
function resolveAnchorIdFor(stepId: string): string | null {
  for (const id of ANCHOR_IDS_BY_STEP[stepId] ?? []) {
    if (typeof document !== "undefined" && document.getElementById(id)) return id;
  }
  return null;
}

function tourStepTitle(step: OnboardingStepDto, data: OnboardingDto): string {
  if (step.completion !== null) return `${step.title}（已完成）`;
  if (step.id === data.currentStepId) return `下一步：${step.title}`;
  return step.title;
}

/** 组装步骤说明：服务端文案 + 目标页面说明 +（弹窗打开时）弹窗确认按钮提示。 */
function composeDescription(step: OnboardingStepDto, anchorId: string | null): string {
  const pageLabel = PAGE_LABELS[step.href];
  const pageHint = pageLabel ? `本步骤在「${pageLabel}」（${step.href}）完成。` : "";
  const dialogHint = anchorId ? DIALOG_HINTS[anchorId] : "";
  return `${step.description}${pageHint}${dialogHint}`;
}

/**
 * I36F 新手引导 Tour：跨页面常驻（挂在 (player) 布局）。引导会话目标步骤由引导页/玩家首页
 * 入口写入，切换页面不丢失当前步骤。步骤完成（服务端推进）只更新展示（标题变为「已完成」），
 * **不会自动前进或跳页**——所有跨步/跨页移动都由 Tour 自己的按钮（下一步/上一步/去完成 →）控制，
 * 玩家可停留在当前页看完开包动画、等待结算等，不会被强制跳走。
 * 目标按钮锚点存在时高亮该按钮并允许直接点击（蒙层留孔洞，点击穿透），否则以居中卡片展示；
 * 跳过为显式幂等命令（服务端判定，重放不重复计数）。
 */
export function OnboardingGuideTour() {
  const { targetStepId, retarget, dismiss, dismissedRef } = useOnboardingGuide();
  const router = useRouter();
  const pathname = usePathname();
  // 常驻 Tour：仅在引导会话激活或位于引导页时才请求引导投影（避免每个玩家页面都轮询）。
  const onboarding = useOnboardingQuery({ enabled: pathname === "/onboarding" || targetStepId !== null });
  const skip = useSkipStepMutation();
  const skipLock = useRef(false);
  const data = onboarding.data?.data.onboarding;
  const [anchorTick, setAnchorTick] = useState(0);

  // 锚点可能晚于步骤切换才挂载：例如创建存档后首页从「未存档」分支切换并重新拉取概览，
  // 每日工作资金卡片（#onboarding-work-funds）比 Tour 推进到该步晚一拍才出现；购买补充包
  // /买入/报名弹窗打开后目标也会从页面按钮切换到弹窗确认按钮。轮询当前步骤锚点（解析结果 id）
  // 变化，出现/消失/切换时强制重渲染，驱动 rc-tour 重新定位并 scrollIntoView。
  useEffect(() => {
    if (targetStepId === null) return;
    let last = resolveAnchorIdFor(targetStepId);
    const timer = window.setInterval(() => {
      const present = resolveAnchorIdFor(targetStepId);
      if (present !== last) {
        last = present;
        setAnchorTick((tick) => tick + 1);
      }
    }, 200);
    return () => window.clearInterval(timer);
  }, [targetStepId, pathname]);

  // 进入引导页时自动开始本次引导会话（从当前未完成步骤开始）；已完成全部步骤或玩家显式
  // 关闭过 Tour 时不自动启动（关闭后只能从引导页/首页/侧栏入口再次显式开启）。
  useEffect(() => {
    if (!data || targetStepId !== null || data.allCompleted || dismissedRef.current) return;
    if (pathname === "/onboarding") retarget(data.currentStepId ?? data.steps[0]?.id ?? null);
  }, [data, pathname, targetStepId, retarget, dismissedRef]);

  // 仅处理异常兜底：目标步骤在服务端投影中已不存在（规则版本切换等）时安全结束会话。
  // 步骤完成绝不自动前进/跳页——前进只由 Tour 按钮控制（见 goNext/goPrev/去完成 →）。
  useEffect(() => {
    if (!data || targetStepId === null) return;
    const idx = data.steps.findIndex((step) => step.id === targetStepId);
    if (idx === -1) dismiss();
  }, [data, targetStepId, dismiss]);

  if (!data || targetStepId === null || data.allCompleted) return null;

  const current = Math.max(0, data.steps.findIndex((step) => step.id === targetStepId));
  const goPrev = () => {
    const prev = current - 1;
    if (prev >= 0 && data.steps[prev]) {
      const step = data.steps[prev]!;
      retarget(step.id);
      if (step.href !== pathname) router.push(step.href);
    }
  };
  const goNext = () => {
    const next = current + 1;
    if (next < data.steps.length && data.steps[next]) {
      const step = data.steps[next]!;
      retarget(step.id);
      if (step.href !== pathname) router.push(step.href);
    }
  };
  // 关闭/完成：显式结束本次引导会话（玩家关闭后不再被自动重启）。
  const finish = () => dismiss();
  const goTo = (href: string) => {
    if (href === pathname) {
      // 已在目标页：锚点可能刚挂载（如创建存档后首页分支切换），强制重新定位并滚动；
      // 否则同页「去完成 →」跳转为 no-op，气泡会一直停留在居中卡片，表现为引导卡死。
      setAnchorTick((tick) => tick + 1);
      return;
    }
    router.push(href);
  };
  const skipStep = (step: OnboardingStepDto) => {
    if (skip.isPending || skipLock.current) return;
    skipLock.current = true;
    skip.mutate({ stepId: step.id }, { onSettled: () => { skipLock.current = false; } });
  };

  // anchorTick 变化会触发本组件重渲染：锚点轮询/同页强制重新定位后，步骤的目标解析与
  // placement/按钮文案都会基于最新 DOM 重算，驱动 rc-tour 重新定位并滚动到目标。
  const steps: NonNullable<TourProps["steps"]> = data.steps.map((step) => {
    const done = step.completion !== null;
    const isLastStep = step.order === data.steps.length;
    const anchorId = step.id === targetStepId ? resolveAnchorIdFor(step.id) : null;
    const targetHere = step.id === targetStepId && anchorTick >= 0 && anchorId !== null;
    // 已完成的步骤由玩家点「下一步/完成引导」推进；未完成且锚点在当前页同样「下一步」；
    // 锚点不在当前页（跨页步骤）显示「去完成 →」先跳到目标页面。
    const primaryLabel = done ? (isLastStep ? "完成引导" : "下一步") : targetHere ? (isLastStep ? "完成引导" : "下一步") : "去完成 →";
    return {
      title: tourStepTitle(step, data),
      description: composeDescription(step, anchorId),
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
                // 跨页步骤：先跳到目标功能页，当前步骤保留以高亮该页按钮/弹窗确认按钮。
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
