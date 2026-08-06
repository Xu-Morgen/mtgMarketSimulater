"use client";

import type { CardFinish, MarketAnnouncementsDto, MarketHeatDto, MarketIndexHistoryDto, MarketQuoteListItemDto, Page, PriceHistoryDto, PriceHistoryRange, QuoteDto } from "@mtg-market/contracts";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "./client";
import { useSession } from "../providers/session-provider";

export type MarketFilters = {
  query?: string | undefined;
  setCode?: string | undefined;
  rarity?: string | undefined;
  finish?: CardFinish | undefined;
  cardRole?: "commander" | undefined;
  tradable?: "any" | "tradable" | "untradable" | undefined;
  sort?: "name" | "marketPrice" | "referencePrice" | undefined;
  direction?: "asc" | "desc" | undefined;
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
  indexHistory: (accessToken: string, range: PriceHistoryRange) => apiRequest<MarketIndexHistoryDto>(`/v1/market/index/history?range=${range}`, { accessToken }),
  /** I34B：行情屏涨跌榜/活跃榜只读聚合；涨跌幅与方向由服务端按报价快照与已结算事实计算。 */
  heat: (accessToken: string) => apiRequest<MarketHeatDto>("/v1/market/heat", { accessToken }),
  /** I34B：系列周期与市场活动公告只读聚合；只含标题、影响范围与生效区间，不含内部系数。 */
  announcements: (accessToken: string) => apiRequest<MarketAnnouncementsDto>("/v1/market/announcements", { accessToken })
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

/** I34F：市场热度（涨跌榜/活跃榜）只读查询；数据仅供展示，浏览器不计算涨跌。 */
export function useMarketHeatQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["market", "heat", user?.id ?? "anonymous"],
    queryFn: () => marketApi.heat(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}

/** I34F：系列周期与市场活动公告只读查询；公告标题/范围/区间均来自服务端。 */
export function useMarketAnnouncementsQuery() {
  const { accessToken, user } = useSession();
  return useQuery({
    queryKey: ["market", "announcements", user?.id ?? "anonymous"],
    queryFn: () => marketApi.announcements(accessToken!),
    enabled: Boolean(accessToken && user),
    retry: false
  });
}
