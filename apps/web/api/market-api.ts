"use client";

import type { CardFinish, MarketQuoteListItemDto, Page, QuoteDto } from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";

export type MarketFilters = {
  query?: string | undefined;
  setCode?: string | undefined;
  rarity?: string | undefined;
  finish?: CardFinish | undefined;
  tradable?: "any" | "tradable" | "untradable" | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
};

export type MarketIndexDto = { referenceIndex: number | null; gameIndex: number | null; quotedSkus: number; capturedAt: string | null };

function queryString(filters: MarketFilters): string {
  const parameters = new URLSearchParams({ limit: String(filters.limit ?? 20) });
  for (const [key, value] of Object.entries(filters)) if (value) parameters.set(key, String(value));
  return parameters.toString();
}

/** 市场页只读取 Fastify 已物化的报价投影；过滤条件不包含兑换率、价差或任何结算参数。 */
export const marketApi = {
  list: (accessToken: string, filters: MarketFilters) => apiRequest<Page<MarketQuoteListItemDto>>(`/v1/market/quotes?${queryString(filters)}`, { accessToken }),
  quote: (accessToken: string, skuId: string) => apiRequest<{ quote: QuoteDto }>(`/v1/market/quotes/${skuId}`, { accessToken }),
  index: (accessToken: string) => apiRequest<MarketIndexDto>("/v1/market/index", { accessToken })
};

export function useMarketQuotesQuery(filters: MarketFilters) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["market", "quotes", user?.id ?? "anonymous", filters],
    queryFn: () => marketApi.list(accessToken!, filters),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

export function useMarketIndexQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["market", "index", user?.id ?? "anonymous"],
    queryFn: () => marketApi.index(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

/** 开包结果仅展示此刻的服务端市场投影；请求失败不回退到旧开包记录中的价格。 */
export function useMarketQuoteQuery(skuId: string) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["market", "quote", user?.id ?? "anonymous", skuId],
    queryFn: () => marketApi.quote(accessToken!, skuId),
    enabled: Boolean(accessToken && user && skuId),
    retry: false
  });
}
