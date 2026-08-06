"use client";

import { Tour, type TourProps } from "antd";
import type { OnboardingDto, OnboardingStepDto } from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnboardingQuery, useSkipStepMutation } from "../api/onboarding-api";
import { decksApi } from "../api/decks-api";
import { useOnboardingGuide } from "../providers/onboarding-guide-context";
import { useSession } from "../providers/session-provider";
import { usePackOpeningAnimationStore } from "../stores/pack-opening-animation-store";
import styles from "./onboarding-guide-tour.module.css";

/**
 * 每个引导步骤的目标锚点 id 列表（按序解析，取第一个实际存在于 DOM 的）：
 * - 「开出第一包」「完成首笔交易」「首次报名」步骤的弹窗打开后，把目标从页面入口按钮切换到
 *   弹窗内的确认按钮——rc-tour 蒙层会在目标位置留出可点击孔洞，点击穿透到弹窗按钮；
 * - 「构筑第一套卡组」会随编辑状态在新建入口、指挥官、服务端检查和保存按钮之间切换；
 * - 其余步骤目标直接指向对应功能页按钮/区块；目标页面不存在时以居中卡片展示。
 */
const ANCHOR_IDS_BY_STEP: Record<string, string[]> = {
  "create-archive": ["onboarding-create-archive"],
  // 可领取时直接框选领取按钮，避免以整张资金卡为目标时气泡覆盖按钮；卡片保留为
  // 状态异常/按钮尚未挂载时的稳定兜底锚点。
  "claim-work-funds": ["onboarding-work-funds-claim", "onboarding-work-funds"],
  "open-first-pack": ["onboarding-pack-confirm", "onboarding-pack-purchase"],
  "view-price-history": ["onboarding-price-history-confirm", "onboarding-view-price-history-focus", "onboarding-view-price-history"],
  "complete-first-npc-trade": ["onboarding-npc-sell-confirm", "onboarding-npc-sell-preview", "onboarding-npc-confirm", "onboarding-npc-preview", "onboarding-npc-guaranteed-trade", "onboarding-npc-buy"],
  "unlock-collection-album": ["onboarding-collection-album-focus", "onboarding-collection-album"],
  "create-first-deck": ["onboarding-npc-confirm", "onboarding-npc-preview", "onboarding-commander-buy", "onboarding-commander-market-focus", "onboarding-deck-save", "onboarding-deck-check", "onboarding-deck-acquire-commander", "onboarding-deck-commander", "onboarding-deck-builder-focus", "onboarding-deck-builder", "onboarding-decks"],
  "first-tournament-registration": ["onboarding-tournament-confirm", "onboarding-tournament-deck-select", "tournament-register-title", "onboarding-tournament-register", "onboarding-tournaments-focus", "onboarding-tournaments", "onboarding-decks"],
  "finish-first-tournament": ["onboarding-tournament-result-focus", "onboarding-tournament-result", "onboarding-tournaments-focus", "onboarding-tournaments"]
};

/** 弹窗确认按钮锚点 → 气泡补充提示（告诉玩家弹窗已打开、在弹窗内点哪个按钮）。 */
const DIALOG_HINTS: Record<string, string> = {
  "onboarding-pack-confirm": "购买弹窗已打开：点击下方「确认购买并开包」完成本步。",
  "onboarding-price-history-confirm": "你已经获得阅读时间。点击「我已查看价格走势，继续交易」，由服务器记录本次学习并进入交易教程。",
  "onboarding-npc-preview": "买入弹窗已打开：确认数量后点击「获取服务端预览」；预览可成交时教程会继续定位确认按钮。",
  "onboarding-npc-confirm": "买入确认弹窗已打开：点击下方「确认向 NPC 买入」完成本步。",
  "onboarding-npc-sell-preview": "保底卖出弹窗已打开：确认数量后点击「获取服务端预览」；预览可成交时教程会继续定位确认按钮。",
  "onboarding-npc-sell-confirm": "保底收购预览已就绪：点击「确认向 NPC 卖出」完成首笔交易。",
  "onboarding-tournament-deck-select": "报名弹窗已打开：先在高亮选择框中选择已保存的合法卡组。",
  "tournament-register-title": "正在读取可用于报名的服务端卡组；选择框出现后教程会自动重新定位。",
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

/** 小型交互控件放在气泡下方，标题/状态锚点放在气泡上方；均避免气泡压在目标本身。 */
function resolvePlacement(anchorId: string | null, targetHere: boolean): "top" | "bottom" | "center" {
  if (!targetHere || anchorId === null) return "center";
  const target = typeof document === "undefined" ? null : document.getElementById(anchorId);
  return target?.matches("button, a, input, select") ? "top" : "bottom";
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
    if (step.id === "create-first-deck") return "点击「新建卡组」进入 Commander 编辑器。教程会继续提示选择指挥官、补足 100 张、请求服务端检查并保存。";
    return "报名比赛需要先有一个已保存的合法 Commander 卡组：请先点击「新建卡组」构筑并保存；保存后点击「前往赛事页」报名。";
  }
  if (anchorId === "onboarding-deck-acquire-commander") return "合法 Commander 卡组必须有一位可用的传奇生物指挥官。当前库存没有候选，请点击高亮链接先去市场购入，再返回卡组编辑器。";
  if (step.id === "create-first-deck" && anchorId === "onboarding-commander-buy") return "市场已只显示可用的传奇生物候选。点击高亮的「向 NPC 买入」，购买 1 张后会自动返回当前卡组草稿。";
  if (step.id === "create-first-deck" && anchorId === "onboarding-npc-preview") return "传奇生物买入弹窗已打开：保持数量 1，获取服务端预览；预览就绪后教程会定位确认按钮。";
  if (step.id === "create-first-deck" && anchorId === "onboarding-npc-confirm") return "确认购买这张传奇生物。服务端成交后会刷新卡组可用库存并自动返回构筑，本次购买不会直接完成组卡步骤。";
  if (step.id === "create-first-deck" && anchorId === "onboarding-commander-market-focus") return "这里是指挥官采购模式，只列出传奇生物。若暂时没有可交易候选，可刷新报价或返回构筑；教程不会在市场与卡组页之间反复跳转。";
  if (anchorId === "onboarding-deck-commander") return "先从可用库存选择一位传奇生物，点击「设为指挥官」。然后填写卡组名称，并用与指挥官颜色标识相符的无限虚拟基本地把卡组补足 100 张。";
  if (anchorId === "onboarding-deck-builder" || anchorId === "onboarding-deck-builder-focus") return "构筑顺序：选择传奇生物作为指挥官 → 填写卡组名称 → 用无限虚拟基本地补足 100 张。浏览器只保存草稿，合法性由服务器检查。";
  if (anchorId === "onboarding-deck-check") return "卡组已达到 100 张。点击「请求服务端检查」；若服务器报告颜色、禁牌或库存问题，请按问题修正后再次检查。";
  if (anchorId === "onboarding-deck-save") return "服务端已确认当前草稿合法。点击「保存草稿」完成组卡教程；保存成功后引导会自动进入比赛报名。";
  if (anchorId === "onboarding-tournament-result" || anchorId === "onboarding-tournament-result-focus") return "报名成功后服务器会异步结算。页面每 3 秒自动刷新；赛果出现后会展示排名、胜负、奖励和重放材料，并自动完成本步。";
  const dialogHint = anchorId ? (DIALOG_HINTS[anchorId] ?? "") : "";
  return `${step.description}${pageHint}${dialogHint}`;
}

/**
 * I36F 新手引导 Tour：跨页面常驻（挂在 (player) 布局）。引导会话目标步骤由引导页/玩家首页
 * 入口写入，切换页面不丢失当前步骤。
 * 自动前进只由服务端步骤从未完成转为完成/跳过触发；DOM 点击仅执行页面意图，不参与完成判定。
 * 开包额外等待翻牌动画 complete（无动画入口用 7 秒兜底），浏览意图、profile 与跳过统一推进。
 * 路由切换期间（router.push 尚未完成）主按钮暂时禁用，避免页面未加载完就允许点到下一步导致卡死。
 * 「首次报名」步骤在玩家没有已保存卡组时先引导到卡组页（/decks）构筑，再前往赛事页报名。
 * 目标按钮锚点存在时高亮该按钮并允许直接点击（蒙层留孔洞，点击穿透），否则以居中卡片展示；
 * 跳过为显式幂等命令（服务端判定，重放不重复计数，确认后自动前进）。
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
  // 自动推进只依据同一目标步骤从「未完成」变为服务端「已完成/已跳过」；DOM 点击不是事实来源。
  const armedStepRef = useRef<string | null>(null);
  const advanceTimerRef = useRef<number | null>(null);
  const packAnimationStartedRef = useRef(false);
  const packAnimationPhase = usePackOpeningAnimationStore((state) => state.phase);

  // 「首次报名」步骤需要已保存卡组：仅当该步为当前目标时才按需查询卡组列表。
  const decks = useQuery({
    queryKey: ["onboarding-decks", user?.id ?? "anonymous"],
    queryFn: () => decksApi.list(accessToken!),
    enabled: Boolean(accessToken && user) && targetStepId === "first-tournament-registration",
    retry: false
  });
  const hasDeck = (decks.data?.data.items.length ?? 0) > 0;

  // 统一的 Tour 导航入口：路由切换期间记录 navigating，pathname 到达后解除；同页则强制重新定位滚动。
  const navigateTo = useCallback((href: string) => {
    if (href === pathname) {
      // 已在目标页：锚点可能刚挂载（如创建存档后首页分支切换），强制重新定位并滚动；
      // 否则同页「去完成 →」跳转为 no-op，气泡会一直停留在居中卡片，表现为引导卡死。
      setAnchorTick((tick) => tick + 1);
      return;
    }
    setNavigating(href);
    router.push(href);
  }, [pathname, router]);

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

  // 路由失败或被守卫拦截时恢复按钮，避免永久停在「正在切换页面」。
  useEffect(() => {
    if (navigating === null) return;
    const timer = window.setTimeout(() => setNavigating(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [navigating]);

  // 服务端状态转换驱动自动前进。开包步骤等待实际翻牌动画 complete 后再前进，避免服务端响应
  // 刚到就切页；浏览意图、跳过、profile 刷新与业务 mutation 均走同一条确定性路径。
  useEffect(() => {
    if (!data || targetStepId === null) return;
    const step = data.steps.find((item) => item.id === targetStepId);
    if (!step) { dismiss(); return; }
    if (targetStepId === "open-first-pack" && packAnimationPhase === "revealing") packAnimationStartedRef.current = true;
    if (step.completion === null) {
      if (armedStepRef.current !== targetStepId) {
        armedStepRef.current = targetStepId;
        packAnimationStartedRef.current = false;
      }
      return;
    }
    if (armedStepRef.current !== targetStepId) return;
    let advanceDelay = 350;
    if (targetStepId === "finish-first-tournament") advanceDelay = 3_000;
    if (targetStepId === "open-first-pack" && step.completion !== "skip") {
      if (packAnimationStartedRef.current && packAnimationPhase !== "complete") return;
      // 批量开包或其他入口没有单包翻牌 phase：给正常 14 张翻牌留足时间后仍可自动推进。
      advanceDelay = packAnimationStartedRef.current ? 650 : 7_000;
    }
    if (advanceTimerRef.current !== null) window.clearTimeout(advanceTimerRef.current);
    advanceTimerRef.current = window.setTimeout(() => {
      advanceTimerRef.current = null;
      armedStepRef.current = null;
      if (data.allCompleted) {
        dismiss();
        navigateTo("/onboarding");
        return;
      }
      const nextStepId = data.currentStepId;
      if (nextStepId) {
        retarget(nextStepId);
        const nextStep = data.steps.find((item) => item.id === nextStepId);
        if (nextStep) navigateTo(nextStep.href);
      }
    }, advanceDelay);
    return () => {
      if (advanceTimerRef.current !== null) {
        window.clearTimeout(advanceTimerRef.current);
        advanceTimerRef.current = null;
      }
    };
  }, [data, targetStepId, retarget, dismiss, navigateTo, packAnimationPhase]);

  if (!data || targetStepId === null || data.allCompleted) return null;

  const current = Math.max(0, data.steps.findIndex((step) => step.id === targetStepId));
  const goPrev = () => {
    armedStepRef.current = null;
    const prev = current - 1;
    if (prev >= 0 && data.steps[prev]) {
      const step = data.steps[prev]!;
      retarget(step.id);
      navigateTo(step.href);
    }
  };
  const goNext = () => {
    armedStepRef.current = null;
    const next = current + 1;
    if (next < data.steps.length && data.steps[next]) {
      const step = data.steps[next]!;
      retarget(step.id);
      navigateTo(step.href);
    }
  };
  // 关闭/完成：显式结束本次引导会话（玩家关闭后不再被自动重启）。
  const finish = () => { armedStepRef.current = null; dismiss(); };
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
    // 旧进度/显式跳过组卡步骤后仍可能没有卡组；报名步骤保留回到卡组页的安全前置提示。
    const deckPhase = step.id === "first-tournament-registration" && anchorId === "onboarding-decks";
    const primaryLabel = done ? (isLastStep ? "完成引导" : "下一步") : targetHere ? "请完成高亮操作" : "去完成 →";
    return {
      title: tourStepTitle(step, data),
      description: composeDescription(step, anchorId),
      placement: resolvePlacement(anchorId, targetHere),
      // step.style 只作用于 Trigger 气泡；不能把宽度写到 Tour className/root style，后者也会
      // 被 rc-tour 复用到全屏 mask，导致遮罩宽度被截成 520px、右半屏漏光。
      style: { maxWidth: "calc(100vw - 24px)", width: "min(520px, calc(100vw - 24px))" },
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
            <button className="button" type="button" disabled={navigating !== null || (!done && targetHere)} onClick={() => {
              if (done) {
                if (deckPhase) {
                  // 卡组前置中间阶段：前往赛事页报名（本步目标页）。
                  navigateTo("/tournaments");
                } else if (isLastStep) {
                  finish();
                } else {
                  goNext();
                }
              } else if (!targetHere) {
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
        if (next >= 0 && next < data.steps.length && data.steps[next]) {
          const step = data.steps[next]!;
          armedStepRef.current = null;
          retarget(step.id);
          navigateTo(step.href);
        }
      }}
      onClose={finish}
      onFinish={finish}
      classNames={{ section: styles.tourPanel ?? "" }}
    />
  );
}
