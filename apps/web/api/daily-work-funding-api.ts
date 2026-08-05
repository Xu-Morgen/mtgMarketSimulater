"use client";

import type { DailyWorkFundingDto, DailyWorkFundingStatusDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { archiveQueryKey, ledgerQueryKey } from "./archive-api";
import { dashboardQueryKey } from "./dashboard-api";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

/** 每日状态由服务器自然日与时区决定；浏览器只缓存并展示该快照。 */
export const dailyWorkFundingQueryKey = (userId: string) => ["daily-work-funding", userId] as const;

export const dailyWorkFundingApi = {
  status: (accessToken: string) => apiRequest<{ status: DailyWorkFundingStatusDto }>("/v1/daily-work-funding", { accessToken }),
  claim: (accessToken: string, idempotencyKey: string) =>
    apiRequest<{ funding: DailyWorkFundingDto }>("/v1/daily-work-funding/claim", { method: "POST", body: {}, accessToken, idempotencyKey })
};

export function useDailyWorkFundingStatusQuery(enabled: boolean) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: dailyWorkFundingQueryKey(user?.id ?? "anonymous"),
    queryFn: () => dailyWorkFundingApi.status(accessToken!),
    enabled: enabled && Boolean(accessToken && user),
    refetchOnMount: "always",
    retry: false
  });
}

/**
 * 同一领取意图的网络重试保留同一幂等键。无论成功、冲突还是跨日，完成后都重新读取服务器
 * 的状态、余额和流水，避免客户端日期或旧缓存决定下一步操作。
 */
export function useClaimDailyWorkFundingMutation() {
  const { accessToken, user } = useSession();
  const queryClient = useQueryClient();
  const idempotencyKey = useRef<string | null>(null);
  const submissionLock = useRef(false);
  const mutation = useMutation({
    mutationFn: async () => {
      idempotencyKey.current ??= createIdempotencyKey();
      return dailyWorkFundingApi.claim(accessToken!, idempotencyKey.current);
    },
    onSuccess: () => {
      idempotencyKey.current = null;
    },
    onSettled: async () => {
      if (!user) return;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: dailyWorkFundingQueryKey(user.id) }),
        queryClient.invalidateQueries({ queryKey: archiveQueryKey(user.id) }),
        queryClient.invalidateQueries({ queryKey: ledgerQueryKey(user.id, null) }),
        queryClient.invalidateQueries({ queryKey: dashboardQueryKey(user.id) }),
        // I36F：领取工作资金完成「领取工作资金」引导步骤，引导 Tour 需刷新服务端进度。
        queryClient.invalidateQueries({ queryKey: ["onboarding", user.id] })
      ]);
    }
  });
  return {
    ...mutation,
    claim: () => {
      if (submissionLock.current) return;
      submissionLock.current = true;
      mutation.mutate(undefined, { onSettled: () => { submissionLock.current = false; } });
    }
  };
}
