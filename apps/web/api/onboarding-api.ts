"use client";

import type { OnboardingDto, OnboardingRewardClaimDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";
import { dashboardQueryKey } from "./dashboard-api";

/**
 * I36F（I36B 新手引导）：引导步骤进度、完成标记、跳过与完成奖励状态全部由服务端基于
 * 已结算事实/状态推进与判定；浏览器只展示服务端结果并提交「跳过 / 查看价格历史 / 领取完成奖励」
 * 三个意图（幂等键 + 状态机），不判定完成、不结算任何经济真相。
 */
export const onboardingQueryKey = (userId: string) => ["onboarding", userId] as const;

export const onboardingApi = {
  overview: (accessToken: string) => apiRequest<{ onboarding: OnboardingDto }>("/v1/onboarding", { accessToken }),
  skip: (accessToken: string, stepId: string, idempotencyKey: string) =>
    apiRequest<{ onboarding: OnboardingDto }>(`/v1/onboarding/steps/${stepId}/skip`, { method: "POST", body: {}, accessToken, idempotencyKey }),
  view: (accessToken: string, stepId: string, path: string, idempotencyKey: string) =>
    apiRequest<{ onboarding: OnboardingDto }>(`/v1/onboarding/steps/${stepId}/view`, { method: "POST", body: { path }, accessToken, idempotencyKey }),
  claim: (accessToken: string, idempotencyKey: string) =>
    apiRequest<{ reward: OnboardingRewardClaimDto }>("/v1/onboarding/reward/claim", { method: "POST", body: {}, accessToken, idempotencyKey })
};

/** 引导只读投影：步骤、完成度、下一步与完成奖励状态；浏览器不得自行判定完成。 */
export function useOnboardingQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: onboardingQueryKey(user?.id ?? "anonymous"),
    queryFn: () => onboardingApi.overview(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

/** 引导命令成功后只失效引导与玩家首页等服务器真相缓存；不本地改进度、不入账。 */
function invalidateOnboardingCaches(queryClient: QueryClient, userId: string): void {
  void queryClient.invalidateQueries({ queryKey: onboardingQueryKey(userId) });
  void queryClient.invalidateQueries({ queryKey: dashboardQueryKey(userId) });
}

/**
 * 跳过引导步骤。同一步骤的网络重试复用幂等键，换步骤才生成新键；成功以服务端投影刷新
 * 引导与首页待办（continue_onboarding 由服务端聚合决定是否保留）。
 */
export function useSkipStepMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<{ key: string; stepId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { stepId: string }) => {
      if (!intent.current || intent.current.stepId !== input.stepId) {
        intent.current = { key: createIdempotencyKey(), stepId: input.stepId };
      }
      return onboardingApi.skip(accessToken!, input.stepId, intent.current.key);
    },
    onSuccess: () => {
      if (user) invalidateOnboardingCaches(queryClient, user.id);
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

/** 提交价格历史页浏览意图（view_event 步骤）；访问事件由服务端唯一约束去重，重放不重复计数。 */
export function useRecordViewStepMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<{ key: string; stepId: string } | null>(null);
  const mutation = useMutation({
    mutationFn: async (input: { stepId: string; path: string }) => {
      if (!intent.current || intent.current.stepId !== input.stepId) {
        intent.current = { key: createIdempotencyKey(), stepId: input.stepId };
      }
      return onboardingApi.view(accessToken!, input.stepId, input.path, intent.current.key);
    },
    onSuccess: () => {
      if (user) invalidateOnboardingCaches(queryClient, user.id);
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

/** 领取一次性完成奖励（幂等键 + 服务端唯一约束防重发）；成功横幅只展示服务端入账与余额。 */
export function useClaimOnboardingRewardMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const intent = useRef<string | null>(null);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!intent.current) intent.current = createIdempotencyKey();
      return onboardingApi.claim(accessToken!, intent.current);
    },
    onSuccess: () => {
      if (user) invalidateOnboardingCaches(queryClient, user.id);
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
