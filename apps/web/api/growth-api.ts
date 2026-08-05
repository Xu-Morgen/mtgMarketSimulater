"use client";

import type { GrowthProfileDto, TaskCenterDto, TaskClaimDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";
import { archiveQueryKey, ledgerQueryKey } from "./archive-api";
import { dashboardQueryKey } from "./dashboard-api";

/**
 * I35F（I35B F3/F5）：任务中心与等级/声望。任务进度、可领取状态与等级经验全部由服务端基于
 * 已结算事实计算与存储；浏览器只展示服务端结果并提交「领取奖励」意图（幂等键 + 状态机），
 * 不判定完成、不统计进度、不推算经验。
 */
export const growthQueryKey = (userId: string) => ["growth", userId] as const;
export const tasksQueryKey = (userId: string) => ["tasks", userId] as const;

export const growthApi = {
  tasks: (accessToken: string) => apiRequest<TaskCenterDto>("/v1/tasks", { accessToken }),
  profile: (accessToken: string) => apiRequest<GrowthProfileDto>("/v1/growth", { accessToken }),
  claim: (accessToken: string, instanceId: string, idempotencyKey: string) =>
    apiRequest<TaskClaimDto>(`/v1/tasks/${instanceId}/claim`, { method: "POST", body: {}, accessToken, idempotencyKey })
};

/** 任务中心：今日 + 本周实例（含 0 进度空态）与可领取数，只读服务端聚合。 */
export function useTasksQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: tasksQueryKey(user?.id ?? "anonymous"),
    queryFn: () => growthApi.tasks(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

/** 等级/声望档案：等级、经验、称号与已解锁能力只由服务端计算。 */
export function useGrowthQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: growthQueryKey(user?.id ?? "anonymous"),
    queryFn: () => growthApi.profile(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

/**
 * 领取任务奖励。同一任务实例的网络重试复用幂等键，换实例才生成新键；成功只失效任务中心、
 * 等级档案、玩家首页与账本/存档等服务器真相缓存，不在浏览器自行入账或推算余额。
 */
export function useClaimTaskMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<{ key: string; instanceId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { instanceId: string }) => {
      if (!intent.current || intent.current.instanceId !== input.instanceId) {
        intent.current = { key: createIdempotencyKey(), instanceId: input.instanceId };
      }
      return growthApi.claim(accessToken!, input.instanceId, intent.current.key);
    },
    onSuccess: () => {
      if (user) {
        void queryClient.invalidateQueries({ queryKey: tasksQueryKey(user.id) });
        void queryClient.invalidateQueries({ queryKey: growthQueryKey(user.id) });
        void queryClient.invalidateQueries({ queryKey: dashboardQueryKey(user.id) });
        void queryClient.invalidateQueries({ queryKey: archiveQueryKey(user.id) });
        void queryClient.invalidateQueries({ queryKey: ledgerQueryKey(user.id, null) });
      }
      intent.current = null;
    }
  });
  return {
    ...mutation,
    beginNewIntent: () => {
      intent.current = null;
      mutation.reset();
    }
  };
}
