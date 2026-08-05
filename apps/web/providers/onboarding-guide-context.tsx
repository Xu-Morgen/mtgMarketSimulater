"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

/** 新手引导 Tour 的跨页面会话：目标步骤由引导页/首页入口写入，antd Tour 组件跨页面监听；
 *  切换页面不丢失当前步骤，步骤完成（服务端推进）后自动前进到下一个未完成步骤。 */
interface OnboardingGuideValue {
  targetStepId: string | null;
  /** 设置当前引导目标步骤；传 null 表示结束本次引导会话。 */
  retarget: (stepId: string | null) => void;
}

const OnboardingGuideContext = createContext<OnboardingGuideValue | null>(null);

/** 供 antd Tour 作为跨页面挂载的持久 Provider（置于 (player) 布局，所有玩家页面共享）。 */
export function OnboardingGuideProvider({ children }: Readonly<{ children: ReactNode }>) {
  const [targetStepId, setTargetStepId] = useState<string | null>(null);

  const retarget = useCallback((stepId: string | null) => {
    setTargetStepId(stepId);
  }, []);

  return (
    <OnboardingGuideContext.Provider value={{ targetStepId, retarget }}>
      {children}
    </OnboardingGuideContext.Provider>
  );
}

export function useOnboardingGuide(): OnboardingGuideValue {
  const value = useContext(OnboardingGuideContext);
  if (!value) throw new Error("useOnboardingGuide 必须在 OnboardingGuideProvider 内使用");
  return value;
}
