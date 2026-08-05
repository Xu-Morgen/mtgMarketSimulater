"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";

/** 新手引导 Tour 的跨页面会话：目标步骤由引导页/首页/侧栏入口写入，antd Tour 组件跨页面监听；
 *  切换页面不丢失当前步骤，步骤完成（服务端推进）后自动前进到下一个未完成步骤。 */
interface OnboardingGuideValue {
  targetStepId: string | null;
  /** 设置当前引导目标步骤；传 null 表示结束本次引导会话。 */
  retarget: (stepId: string | null) => void;
  /** 玩家显式关闭 Tour：本轮会话内不再被引导页自动重启（重新点击引导入口才会再次开启）。 */
  dismiss: () => void;
  /** 是否被玩家显式关闭过（只读，供自动重启判定）。 */
  dismissedRef: React.MutableRefObject<boolean>;
}

const OnboardingGuideContext = createContext<OnboardingGuideValue | null>(null);

/** 供 antd Tour 作为跨页面挂载的持久 Provider（置于 (player) 布局，所有玩家页面共享）。 */
export function OnboardingGuideProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [targetStepId, setTargetStepId] = useState<string | null>(null);
  // 玩家显式关闭过 Tour：本轮会话（Provider 生命周期）内自动重启只允许从引导页/入口再次显式开启。
  // 用 ref 而不是 state，避免关闭 → 引导页自动重开 → 关不掉的死循环。
  const dismissedRef = useRef(false);

  const retarget = useCallback((stepId: string | null) => {
    if (stepId !== null) dismissedRef.current = false; // 显式开启/切换步骤：清除已关闭标记
    setTargetStepId(stepId);
  }, []);

  const dismiss = useCallback(() => {
    dismissedRef.current = true;
    setTargetStepId(null);
  }, []);

  return (
    <OnboardingGuideContext.Provider value={{ targetStepId, retarget, dismiss, dismissedRef }}>
      {children}
    </OnboardingGuideContext.Provider>
  );
}

export function useOnboardingGuide(): OnboardingGuideValue {
  const value = useContext(OnboardingGuideContext);
  if (!value) throw new Error("useOnboardingGuide 必须在 OnboardingGuideProvider 内使用");
  return value;
}
