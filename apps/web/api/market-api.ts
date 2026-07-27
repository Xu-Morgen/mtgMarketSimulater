"use client";

import type { CardFinish, MarketIndexHistoryDto, MarketQuoteListItemDto, Page, PriceHistoryDto, PriceHistoryRange, QuoteDto } from "@mtg-market/contracts";
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
  index: (accessToken: string) => apiRequest<MarketIndexDto>("/v1/market/index", { accessToken }),
  /** I17F：按自然日采样的只追加历史；服务端决定 7d/30d/all 窗口与 null 缺失点，浏览器不插值。 */
  history: (accessToken: string, skuId: string, range: PriceHistoryRange) => apiRequest<PriceHistoryDto>(`/v1/market/quotes/${skuId}/history?range=${range}`, { accessToken }),
  /** I17F：全服指数历史；与单卡历史共用 range 语义。 */
  indexHistory: (accessToken: string, range: PriceHistoryRange) => apiRequest<MarketIndexHistoryDto>(`/v1/market/index/history?range=${range}`, { accessToken })
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

/** I17F：单卡价格历史只读只追加的服务端按日采样；切换 SKU 或 range 才重新请求。 */
export function usePriceHistoryQuery(skuId: string | null, range: PriceHistoryRange) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["market", "price-history", user?.id ?? "anonymous", skuId, range],
    queryFn: () => marketApi.history(accessToken!, skuId!, range),
    enabled: Boolean(accessToken && user && skuId),
    retry: false
  });
}

/** I17F：市场指数历史；空 points 来自服务端“无历史”而非失败。 */
export function useMarketIndexHistoryQuery(range: PriceHistoryRange) {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["market", "index-history", user?.id ?? "anonymous", range],
    queryFn: () => marketApi.indexHistory(accessToken!, range),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}
