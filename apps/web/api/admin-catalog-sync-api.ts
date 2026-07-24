"use client";

import type { CatalogSyncStatusDto, JobDto } from "@mtg-market/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";
import { createIdempotencyKey } from "../utils/idempotency";

export const catalogSyncQueryKey = (userId: string) => ["admin", "catalog-sync", userId] as const;

/** 管理端只调用本地 Fastify 管理 API；同步 Provider 永不进入浏览器请求链。 */
export const adminCatalogSyncApi = {
  status: (accessToken: string) => apiRequest<CatalogSyncStatusDto>("/v1/admin/catalog/sync", { accessToken }),
  trigger: (accessToken: string, idempotencyKey: string) => apiRequest<JobDto>("/v1/admin/catalog/sync", { method: "POST", body: {}, accessToken, idempotencyKey }),
  cacheImage: (accessToken: string, payload: { scope: "single"; skuId: string } | { scope: "set"; setCode: string }, idempotencyKey: string) => apiRequest<JobDto>("/v1/admin/catalog/image-cache", { method: "POST", body: payload, accessToken, idempotencyKey }),
  retry: (accessToken: string, jobId: string, idempotencyKey: string) => apiRequest<JobDto>(`/v1/admin/jobs/${jobId}/retry`, { method: "POST", accessToken, idempotencyKey })
};

export function useCatalogSyncStatusQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: catalogSyncQueryKey(user?.id ?? "anonymous"), queryFn: () => adminCatalogSyncApi.status(accessToken!), enabled: Boolean(accessToken && user?.role === "admin"), retry: false,
    refetchInterval: (query) => {
      const states = [query.state.data?.data.currentJob?.status, query.state.data?.data.currentImageCacheJob?.status];
      return states.some((state) => state === "pending" || state === "running") ? 2_000 : false;
    }
  });
}

function useCatalogSyncMutation(kind: "trigger" | "retry") {
  const { accessToken, user } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: async (jobId?: string) => kind === "trigger" ? adminCatalogSyncApi.trigger(accessToken!, createIdempotencyKey()) : adminCatalogSyncApi.retry(accessToken!, jobId!, createIdempotencyKey()),
    onSuccess: () => void client.invalidateQueries({ queryKey: catalogSyncQueryKey(user!.id) })
  });
}

export function useTriggerCatalogSyncMutation() { return useCatalogSyncMutation("trigger"); }

export function useCacheCatalogImageMutation() {
  const { accessToken, user } = useSession(); const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: { scope: "single"; skuId: string } | { scope: "set"; setCode: string }) => adminCatalogSyncApi.cacheImage(accessToken!, payload, createIdempotencyKey()),
    onSuccess: () => void client.invalidateQueries({ queryKey: catalogSyncQueryKey(user!.id) })
  });
}
export function useRetryCatalogSyncMutation() { return useCatalogSyncMutation("retry"); }
