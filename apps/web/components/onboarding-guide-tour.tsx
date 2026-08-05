"use client";

import { Tour, type TourProps } from "antd";
import type { OnboardingDto, OnboardingStepDto } from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useOnboardingQuery, useSkipStepMutation } from "../api/onboarding-api";
import { decksApi } from "../api/decks-api";
import { useOnboardingGuide } from "../providers/onboarding-guide-context";
import { useSession } from "../providers/session-provider";
import styles from "./onboarding-guide-tour.module.css";

/**
 * 每个引导步骤的目标锚点 id 列表（按序解析，取第一个实际存在于 DOM 的）：
 * - 「开出第一包」「完成首笔交易」「首次报名」步骤的弹窗打开后，把目标从页面入口按钮切换到
 *   弹窗内的确认按钮——rc-tour 蒙层会在目标位置留出可点击孔洞，点击穿透到弹窗按钮；
 * - 「首次报名」在玩家没有已保存卡组时，目标为卡组页的「新建卡组」入口（先构筑再报名）；
 * - 其余步骤目标直接指向对应功能页按钮/区块；目标页面不存在时以居中卡片展示。
 */
const ANCHOR_IDS_BY_STEP: Record<string, string[]> = {
  "create-archive": ["onboarding-create-archive"],
  "claim-work-funds": ["onboarding-work-funds"],
  "open-first-pack": ["onboarding-pack-confirm", "onboarding-pack-purchase"],
  "view-price-history": ["onboarding-view-price-history"],
  "complete-first-npc-trade": ["onboarding-npc-confirm", "onboarding-npc-buy"],
  "unlock-collection-album": ["onboarding-collection-album"],
  "first-tournament-registration": ["onboarding-tournament-confirm", "onboarding-tournament-register", "onboarding-tournaments", "onboarding-decks"]
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
  "/decks": "我的卡组",
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

/** 组装步骤说明：服务端文案 + 目标页面说明 +（弹窗打开/卡组前置时）操作提示。 */
function composeDescription(step: OnboardingStepDto, anchorId: string | null): string {
  const pageLabel = PAGE_LABELS[step.href];
  const pageHint = pageLabel ? `本步骤在「${pageLabel}」（${step.href}）完成。` : "";
  if (anchorId === "onboarding-decks") {
    return "报名比赛需要先有一个已保存的合法 Commander 卡组：请先点击「新建卡组」构筑并保存；保存后点击「前往赛事页」报名。";
  }
  const dialogHint = anchorId ? DIALOG_HINTS[anchorId] : "";
  return `${step.description}${pageHint}${dialogHint}`;
}

/**
 * I36F 新手引导 Tour：跨页面常驻（挂在 (player) 布局）。引导会话目标步骤由引导页/玩家首页
 * 入口写入，切换页面不丢失当前步骤。
 * **所有步骤前进/跳转都只由 Tour 按钮触发**（下一步/上一步/去完成 →）：点击高亮目标按钮只执行
 * 该步骤的业务动作（创建存档/领取/购买确认等），步骤完成（服务端推进）只把气泡标题更新为
 * 「x（已完成）」并停留在当前页，绝不自动跳转——玩家可看完开包动画、等待结算，不会被强制跳走。
 * 路由切换期间（router.push 尚未完成）主按钮暂时禁用，避免页面未加载完就允许点到下一步导致卡死。
 * 「首次报名」步骤在玩家没有已保存卡组时先引导到卡组页（/decks）构筑，再前往赛事页报名。
 * 目标按钮锚点存在时高亮该按钮并允许直接点击（蒙层留孔洞，点击穿透），否则以居中卡片展示；
 * 跳过为显式幂等命令（服务端判定，重放不重复计数，跳过不自动前进）。
 */
export function OnboardingGuideTour() {
  const { targetStepId, retarget, dismiss, dismissedRef } = useOnboardingGuide();
  const router = useRouter();
  const pathname = usePathname();
  const { accessToken, user } = useSession();
  // 常驻 Tour：仅在引导会话激活或位于引导页时才请求引导投影（避免每个玩家页面都轮询）。
  const onboarding = useOnboardingQuery({ enabled: pathname === "/onboarding" || targetStepId !== null });
  const skip = useSkipStepMutation();
  const skipLock = useRef(false);
  const data = onboarding.data?.data.onboarding;
  const [anchorTick, setAnchorTick] = useState(0);
  // 路由切换进行中（router.push 已发出、目标路径尚未渲染）：切换完成前主按钮禁用。
  const [navigating, setNavigating] = useState<string | null>(null);

  // 「首次报名」步骤需要已保存卡组：仅当该步为当前目标时才按需查询卡组列表。
  const decks = useQuery({
    queryKey: ["onboarding-decks", user?.id ?? "anonymous"],
    queryFn: () => decksApi.list(accessToken!),
    enabled: Boolean(accessToken && user) && targetStepId === "first-tournament-registration",
    retry: false
  });
  const hasDeck = (decks.data?.data.items.length ?? 0) > 0;

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

  // 路由切换完成：pathname 到达目标后解除导航门禁（主按钮恢复可用）。
  useEffect(() => {
    if (navigating !== null && pathname === navigating) setNavigating(null);
  }, [pathname, navigating]);

  // 仅处理异常兜底：目标步骤在服务端投影中已不存在（规则版本切换等）时安全结束会话。
  // 步骤完成绝不自动前进/跳页——前进只由 Tour 按钮控制。
  useEffect(() => {
    if (!data || targetStepId === null) return;
    const idx = data.steps.findIndex((step) => step.id === targetStepId);
    if (idx === -1) dismiss();
  }, [data, targetStepId, dismiss]);

  if (!data || targetStepId === null || data.allCompleted) return null;

  const current = Math.max(0, data.steps.findIndex((step) => step.id === targetStepId));
  const navigateTo = (href: string) => {
    if (href === pathname) {
      // 已在目标页：锚点可能刚挂载（如创建存档后首页分支切换），强制重新定位并滚动；
      // 否则同页「去完成 →」跳转为 no-op，气泡会一直停留在居中卡片，表现为引导卡死。
      setAnchorTick((tick) => tick + 1);
      return;
    }
    setNavigating(href);
    router.push(href);
  };
  const goPrev = () => {
    const prev = current - 1;
    if (prev >= 0 && data.steps[prev]) {
      const step = data.steps[prev]!;
      retarget(step.id);
      navigateTo(step.href);
    }
  };
  const goNext = () => {
    const next = current + 1;
    if (next < data.steps.length && data.steps[next]) {
      const step = data.steps[next]!;
      retarget(step.id);
      navigateTo(step.href);
    }
  };
  // 关闭/完成：显式结束本次引导会话（玩家关闭后不再被自动重启）。
  const finish = () => dismiss();
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
    // 「首次报名」在卡组页时处于「先构筑卡组」中间阶段：主按钮改为前往赛事页（不是完成引导）。
    const deckPhase = step.id === "first-tournament-registration" && anchorId === "onboarding-decks";
    const primaryLabel = done ? (isLastStep ? "完成引导" : "下一步") : targetHere
      ? (deckPhase ? "前往赛事页" : (isLastStep ? "完成引导" : "下一步"))
      : "去完成 →";
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
            <button className="button" type="button" disabled={navigating !== null} onClick={() => {
              if (done || targetHere) {
                if (deckPhase) {
                  // 卡组前置中间阶段：前往赛事页报名（本步目标页）。
                  navigateTo("/tournaments");
                } else if (isLastStep) {
                  finish();
                } else {
                  goNext();
                }
              } else {
                // 跨页步骤：「首次报名」先按是否已有卡组决定去向（无卡组 → 卡组页），其余按步骤 href。
                if (step.id === "first-tournament-registration") {
                  navigateTo(hasDeck ? "/tournaments" : "/decks");
                } else {
                  navigateTo(step.href);
                }
              }
            }}>{navigating !== null ? "正在切换页面…" : primaryLabel}</button>
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
