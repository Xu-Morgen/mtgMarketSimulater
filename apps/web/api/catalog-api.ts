"use client";

import type { CatalogSkuDetailDto, CatalogSkuDto, CardFinish, Page } from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";

export type CatalogFilters = {
  query?: string | undefined;
  setCode?: string | undefined;
  rarity?: string | undefined;
  finish?: CardFinish | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

function queryString(filters: CatalogFilters): string {
  const parameters = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  for (const [key, value] of Object.entries(filters)) if (value) parameters.set(key, String(value));
  return parameters.toString();
}

/** 目录只请求本地 Fastify API，绝不在浏览器访问外部卡牌或图片 Provider。 */
export const catalogApi = {
  list: (accessToken: string, filters: CatalogFilters) => apiRequest<Page<CatalogSkuDto>>(`/v1/catalog/cards?${queryString(filters)}`, { accessToken }),
  detail: (accessToken: string, skuId: string) => apiRequest<{ sku: CatalogSkuDetailDto }>(`/v1/catalog/cards/${skuId}`, { accessToken })
};

export function useCatalogQuery(filters: CatalogFilters) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["catalog", user?.id ?? "anonymous", filters],
    queryFn: () => catalogApi.list(accessToken!, filters),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

export function useCatalogDetailQuery(skuId: string | null) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["catalog", "detail", user?.id ?? "anonymous", skuId],
    queryFn: () => catalogApi.detail(accessToken!, skuId!),
    enabled: Boolean(accessToken && user && skuId),
    retry: false
  });
}
