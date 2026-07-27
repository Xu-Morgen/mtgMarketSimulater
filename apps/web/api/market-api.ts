"use client";

import type { CardFinish, MarketQuoteListItemDto, Page } from "@mtg-market/contracts";
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
