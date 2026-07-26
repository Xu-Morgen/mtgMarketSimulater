"use client";

import type { ApiSuccess, JobDto, PriceSyncStatusDto, PublicPriceStatusDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

export const publicPriceStatusQueryKey = (userId: string) => ["prices", "public-status", userId] as const;
export const adminPriceSyncQueryKey = (userId: string) => ["admin", "prices", "sync", userId] as const;
export type PriceSyncTriggerPayload = { allowChecksumMismatch?: true };

/** 只读取本地 Fastify 已脱敏的公开状态，不把同步运行详情交给玩家浏览器。 */
export const pricingApi = {
  publicStatus: (accessToken: string) => apiRequest<PublicPriceStatusDto>("/v1/prices/status", { accessToken }),
  adminSyncStatus: (accessToken: string) => apiRequest<PriceSyncStatusDto>("/v1/admin/prices/sync", { accessToken }),
  triggerSync: (accessToken: string, idempotencyKey: string, payload: PriceSyncTriggerPayload) => apiRequest<JobDto>("/v1/admin/prices/sync", { method: "POST", body: payload, accessToken, idempotencyKey })
};

export function usePublicPriceStatusQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: publicPriceStatusQueryKey(user?.id ?? "anonymous"),
    queryFn: () => pricingApi.publicStatus(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

export function useAdminPriceSyncStatusQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: adminPriceSyncQueryKey(user?.id ?? "anonymous"),
    queryFn: () => pricingApi.adminSyncStatus(accessToken!),
    enabled: Boolean(accessToken && user?.role === "admin"),
    retry: false,
    refetchInterval: (query) => {
      const status = query.state.data?.data.currentJob?.status;
      return status === "pending" || status === "running" ? 2_000 : false;
    }
  });
}

/** 同一同步模式的网络重试保留幂等键；切换为管理员覆写是新的受审计意图。 */
export function useTriggerPriceSyncMutation() {
  const { accessToken, user } = useSession();
  const client = useQueryClient();
  const intent = useRef<{ fingerprint: "verified" | "bypassed"; idempotencyKey: string } | null>(null);
  return useMutation({
    mutationFn: (payload: PriceSyncTriggerPayload = {}) => {
      const fingerprint = payload.allowChecksumMismatch ? "bypassed" : "verified";
      if (!intent.current || intent.current.fingerprint !== fingerprint) intent.current = { fingerprint, idempotencyKey: createIdempotencyKey() };
      return pricingApi.triggerSync(accessToken!, intent.current.idempotencyKey, payload);
    },
    onSuccess: ({ data: job }) => {
      const key = adminPriceSyncQueryKey(user!.id);
      // 先写入任务返回值，避免失效查询尚未完成时重复点击又创建一个新任务。
      client.setQueryData<ApiSuccess<PriceSyncStatusDto>>(key, (existing) => existing ? {
        ...existing,
        data: { ...existing.data, currentJob: job }
      } : existing);
      intent.current = null;
      void client.invalidateQueries({ queryKey: key });
    }
  });
}
