"use client";

import { create } from "zustand";

export type PackOpeningAnimationPhase = "idle" | "revealing" | "complete";

type PackOpeningAnimationState = {
  phase: PackOpeningAnimationPhase;
  revealedCount: number;
  start: () => void;
  revealNext: (total: number) => void;
  skip: (total: number) => void;
  reset: () => void;
};

/** 仅保存可丢弃的动画进度；服务端开包结果绝不写入 Zustand。 */
export const usePackOpeningAnimationStore = create<PackOpeningAnimationState>((set) => ({
  phase: "idle",
  revealedCount: 0,
  start: () => set({ phase: "revealing", revealedCount: 0 }),
  revealNext: (total) =>
    set((state) => {
      const revealedCount = Math.min(state.revealedCount + 1, total);
      return { revealedCount, phase: revealedCount === total ? "complete" : "revealing" };
    }),
  skip: (total) => set({ phase: "complete", revealedCount: total }),
  reset: () => set({ phase: "idle", revealedCount: 0 })
}));
